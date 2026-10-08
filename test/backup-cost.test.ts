// Workstream E: what a full backup costs at the load-test scale (4,000 tickets
// with screenshots across 10 parties), measured from the export's own log lines.
// The rows are synthetic (inserted directly) with these per-ticket ratios: 4
// change-log entries (sign-up, approval, release, admission), 4 audit rows, 1
// scan, 1 screenshot. Rows read do not depend on row contents, only on counts.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { PAGE_DEFAULT, PAGE_MAX } from "../src/backup/export";
import { backupGet, exportAll, harness, type Harness } from "./helpers";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
});
afterEach(() => vi.restoreAllMocks());

const TICKETS = 4000;
const PARTIES = 10;
let h: Harness;

beforeAll(async () => {
  h = await harness();
  const main: D1PreparedStatement[] = [];
  const ledger: D1PreparedStatement[] = [];
  const files: D1PreparedStatement[] = [];
  const shot = new Uint8Array(64).fill(7);
  for (let p = 0; p < PARTIES; p++) {
    const party = `cost-${p}`;
    main.push(env.DB.prepare("INSERT INTO parties (id, name, capacity, created_at, logged_rev) VALUES (?, ?, 1000, 0, 1)").bind(party, `Party ${p}`));
    for (let s = 0; s < 5; s++) {
      main.push(env.DB.prepare("INSERT INTO staff (id, party_id, name, role, created_at, logged_rev) VALUES (?, ?, 'Staff', 'door', 0, 1)").bind(`${party}-s${s}`, party));
    }
  }
  for (let i = 0; i < TICKETS; i++) {
    const party = `cost-${i % PARTIES}`;
    const id = `T${String(i).padStart(15, "0")}`;
    const row = { id, party_id: party, qr_version: 1, status: "approved", people: 1, guest_name: `Guest ${i}`, guest_email: `guest${i}@example.com`,
      answers: '{"q1":"an answer of a typical length"}', screenshot_key: `1:${i + 1}`, created_at: 1_790_000_000_000 + i, approved_at: 1, released_at: 1,
      used_at: 1, used_scan_id: `scan-${i}`, rev: 4, last_op: "00000000-0000-4000-8000-000000000000", last_action: "admitted" };
    main.push(env.DB.prepare(`INSERT INTO tickets (id, party_id, qr_version, status, people, guest_name, guest_email, answers, screenshot_key, created_at,
      approved_at, released_at, used_at, used_scan_id, rev, logged_rev, last_op, last_action) VALUES (?, ?, 1, 'approved', 1, ?, ?, ?, ?, ?, 1, 1, 1, ?, 4, 4, ?, 'admitted')`)
      .bind(id, party, row.guest_name, row.guest_email, row.answers, row.screenshot_key, row.created_at, row.used_scan_id, row.last_op));
    main.push(env.DB.prepare(`INSERT INTO scans (scan_id, party_id, session_hash, staff_id, ticket_id, qr_version, qr_fingerprint, pause_number, created_at, outcome, ticket_rev)
      VALUES (?, ?, ?, ?, ?, 1, ?, 1, 1, 'admitted', 4)`).bind(row.used_scan_id, party, "a".repeat(64), `${party}-s0`, id, "b".repeat(64)));
    for (let r = 1; r <= 4; r++) {
      main.push(env.DB.prepare("INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail) VALUES (?, 1, NULL, 'x', 'ticket', ?, ?, NULL)").bind(party, id, r));
      ledger.push(env.LEDGER.prepare("INSERT INTO change_log (event_id, party_id, entity, entity_id, rev, action, logged_at, state) VALUES (?, ?, 'ticket', ?, ?, 'x', 1, ?)")
        .bind(`ticket:${id}:${r}`, party, id, r, JSON.stringify({ ...row, rev: r })));
    }
    files.push(env.FILES!.prepare("INSERT INTO files (id, party_id, ticket_id, content_type, size, bytes, created_at) VALUES (?, ?, ?, 'image/jpeg', ?, ?, 1)").bind(i + 1, party, id, shot.length, shot));
  }
  for (const [db, list] of [[env.DB, main], [env.LEDGER, ledger], [env.FILES!, files]] as const) {
    for (let i = 0; i < list.length; i += 200) await db.batch(list.slice(i, i + 200));
  }
}, 120_000);

function usage() {
  const lines = logs.filter((l) => l.startsWith('{"evt":"backup"')).map((l) => JSON.parse(l) as Record<string, number>);
  const sum = (k: string) => lines.reduce((a, x) => a + Number(x[k] ?? 0), 0);
  return { requests: lines.length, main: sum("main_rows_read"), ledger: sum("ledger_rows_read"), files: sum("files_rows_read"), written: sum("rows_written") };
}

it("rows read by a full backup of 4,000 tickets with screenshots", async () => {
  const rows = Number(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM tickets) + (SELECT COUNT(*) FROM scans) + (SELECT COUNT(*) FROM audit) + (SELECT COUNT(*) FROM parties) + (SELECT COUNT(*) FROM staff) AS n").first("n"))
    + Number(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM change_log").first("n")) + TICKETS;
  const report: Record<string, unknown> = { rows_in_backup: rows };
  for (const limit of [PAGE_DEFAULT, PAGE_MAX]) {
    logs = [];
    const exp = await exportAll(h, limit);
    expect(exp.files.size).toBe(TICKETS);
    const u = usage();
    expect(u.written).toBe(0);
    const total = u.main + u.ledger + u.files;
    // Each row is read once, plus the manifest's counts (about one more read per row), one per screenshot
    // download, and one more per screenshot in the list and per download (the purge-mark lookup).
    expect(total).toBeLessThan(rows * 2 + TICKETS * 3 + 2000);
    report[`page_${limit}`] = { requests: u.requests, rows_read: total, main: u.main, ledger: u.ledger, files: u.files };
  }
  // Hourly: ledger + screenshot list, no new screenshot to download.
  logs = [];
  await exportAll(h, PAGE_MAX, { kind: "hourly", files: false });
  report.hourly = usage();
  logs = [];
  await backupGet(h, "/api/backup/manifest");
  report.manifest_without_counts = usage();
  logs = [];
  await backupGet(h, "/api/backup/manifest?counts=1");
  report.manifest_with_counts = usage();
  logs = [];
  const first = await backupGet(h, `/api/backup/rows/ledger/change_log?limit=${PAGE_MAX}`);
  const body = await first.text();
  report.change_log_page_max = { ...usage(), response_bytes: body.length };
  // Measured (docs/DECISIONS.md, workstream E): 44,061 rows in the backup; a full export with
  // counts and every screenshot downloaded reads 100,268 rows (main 48,219, ledger 32,019,
  // files 20,030: list and download each also look up the purge mark) whatever the page
  // size; the manifest's counts alone read 44,194; without counts the manifest reads 133. A change-log page of 500 rows is about 313 KB of JSON.
  expect(report.manifest_without_counts).toMatchObject({ requests: 1, written: 0 });
  // Hourly (ledger + screenshot list, nothing new to download; 500-row pages): 24,138 rows read
  // (main 89: manifest and schedule, ledger 16,019, files 8,030: each listed screenshot also
  // looks up its purge mark) in 46 requests.
  const hourly = report.hourly as { main: number; ledger: number; files: number; written: number };
  expect(hourly.written).toBe(0);
  expect(hourly.main).toBeLessThan(200);
  expect(hourly.ledger + hourly.files).toBeLessThan(rows * 0.6);
  expect((report.change_log_page_max as { ledger: number }).ledger).toBeLessThanOrEqual(PAGE_MAX);
}, 180_000);
