// Workstream E: backups outside Cloudflare. The export endpoints the owner's
// Apps Script calls: signed requests only, read-only, paged by primary key, and
// a full export -> restore into fresh databases -> identical rows and identical
// screenshot bytes, checked again by the recovery engine (verify / replay).
import { applyD1Migrations, env } from "cloudflare:test";
import { MAX_FILE_BYTES, purgeOldScreenshots, resetUploadTarget } from "../src/storage";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { canonical, signedHeaders, SIG_HEADER, TIME_HEADER } from "../src/backup/auth";
import { EXPORTED, excludedIn, exportedFor, INTERNAL_TABLE, PAGE_MAX, schedule, selectOf, tablesFor, type BackupDb, type TableSpec } from "../src/backup/export";
import { BUDGET_STOP_AT } from "../src/limits";
import { compareRestore, loadBackup, sha256hexBytes } from "../src/backup/restore";
import { D1Driver, type SqlDriver } from "../src/db/driver";
import { newId } from "../src/lib/crypto";
import { flushAll, replay, verify } from "../src/recovery";
import { api, backupGet, backupPost, exportAll, seedOwner, seedSession, guestParty, harness, JPEG, openParty, ORIGIN, scan, seedDoor, signup, testTickets, type Harness } from "./helpers";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
});
afterEach(() => vi.restoreAllMocks());

const parsed = (evt: string) => logs.filter((l) => l.startsWith(`{"evt":"${evt}"`)).map((l) => JSON.parse(l) as Record<string, number | string>);

// The largest screenshot the server accepts.
const BIG = MAX_FILE_BYTES;
let bigShot: Uint8Array;
let h: Harness;
/** Screenshots in the second files database (FILES_2), and screenshots the retention purge emptied. */
const shard2: { ticket: string; id: number; sha: string }[] = [];
const purged: { db: "files" | "files_2"; id: number }[] = [];

/** Both files databases the tests bind (FILES, FILES_2). */
const SPECS = exportedFor(["files", "files_2"]);
const live = (db: BackupDb): D1Database => (db === "main" ? env.DB : db === "ledger" ? env.LEDGER : db === "files" ? env.FILES! : env.FILES_2!);
const restored = (db: BackupDb): D1Database => (db === "main" ? env.RESTORE_MAIN : db === "ledger" ? env.RESTORE_LEDGER : db === "files" ? env.RESTORE_FILES : env.RESTORE_FILES_2);
const selectAll = (spec: TableSpec) => { const s = selectOf(spec); return `SELECT ${s.cols} FROM ${s.from} ORDER BY ${spec.key.map(s.key).join(", ")}`; };

/** A files database that reports itself `bytes` big (D1's meta.size_after), so uploads move on to the next one. */
function sized(d: D1Database, bytes: number): D1Database {
  return new Proxy(d, {
    get(t, p) {
      if (p === "prepare") return (q: string) => (q === "SELECT 1" ? { all: async () => ({ results: [{ 1: 1 }], meta: { size_after: bytes } }) } : t.prepare(q));
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}

/** Tickets, an admission, guest sign-ups with screenshots (one of the maximum size), an approval, a release, a cancel with its intent. */
async function world() {
  const p = await openParty(h);
  const door = await seedDoor(p.party, h.clock);
  const tickets = await testTickets(h, p.os, 6);
  expect((await scan(h, door, tickets[0]!.qr)).verdict).toBe("admit");
  const g = await guestParty(h);
  const ids: string[] = [];
  for (let i = 0; i < 4; i++) {
    const shot = new Uint8Array(2000 + i * 777);
    crypto.getRandomValues(shot);
    shot.set(JPEG);
    const s = await signup(h, g.party, { screenshot: shot });
    expect(s.status).toBe(201);
    ids.push(s.body.ticket_id!);
  }
  bigShot = new Uint8Array(BIG);
  for (let i = 0; i < BIG; i += 65536) crypto.getRandomValues(bigShot.subarray(i, Math.min(BIG, i + 65536)));
  bigShot.set(JPEG);
  const s = await signup(h, g.party, { screenshot: bigShot });
  expect(s.status).toBe(201);
  expect((await h.req("/api/tickets/approve", api(g.os, { ids: ids.slice(0, 2) }))).status).toBe(200);
  expect((await h.req("/api/tickets/release", api(g.os, { ids: ids.slice(0, 1) }))).status).toBe(200);
  expect((await h.req(`/api/tickets/${ids[3]}/cancel`, api(g.os, { op: newId() }))).status).toBe(200);
  // Two sign-ups land in the second files database (the first reports itself past 70%).
  resetUploadTarget();
  const h2 = await harness({ clock: h.clock, env: { FILES: sized(env.FILES!, 360e6), FILES_2: env.FILES_2 } as never });
  const ids2: string[] = [];
  for (let i = 0; i < 2; i++) {
    const shot = new Uint8Array(3000 + i * 500);
    crypto.getRandomValues(shot);
    shot.set(JPEG);
    const s2 = await signup(h2, g.party, { screenshot: shot });
    expect(s2.status).toBe(201);
    const key = String(await env.DB.prepare("SELECT screenshot_key FROM tickets WHERE id = ?").bind(s2.body.ticket_id).first("screenshot_key"));
    expect(key).toMatch(/^f2:/);
    shard2.push({ ticket: s2.body.ticket_id!, id: Number(key.slice(3)), sha: await sha256hexBytes(shot) });
    ids2.push(s2.body.ticket_id!);
  }
  resetUploadTarget();
  // Retention: a cancelled ticket's screenshot is emptied 30 days later (one in each database).
  expect((await h.req(`/api/tickets/${ids2[1]}/cancel`, api(g.os, { op: newId() }))).status).toBe(200);
  const purge = await purgeOldScreenshots(env, new D1Driver(env.DB), h.clock.now() + 31 * 86_400_000);
  expect(purge.databases.map((d) => d.deleted.cancelled ?? 0)).toEqual([1, 1]);
  for (const [db, d] of [["files", env.FILES!], ["files_2", env.FILES_2!]] as const) {
    for (const r of (await d.prepare("SELECT id FROM file_tombstones").all<{ id: number }>()).results) purged.push({ db, id: r.id });
  }
  // Composite primary keys with several rows sharing a first key column, to cross page boundaries inside them.
  const op = newId();
  for (let i = 0; i < 5; i++) {
    await env.LEDGER.prepare("INSERT INTO intents (op_id, entity, entity_id, party_id, action, created_at) VALUES (?, 'ticket', ?, ?, 'test', 1)").bind(op, `T${i}`, p.party).run();
  }
  for (const [prov, n] of [["brevo", 3], ["gmail", 5]] as const) {
    for (let i = 0; i < n; i++) await env.DB.prepare("INSERT INTO email_quota (provider, hour, sent) VALUES (?, ?, 1)").bind(prov, 490_000 + i).run();
  }
  // Seeds write rows directly; in production every row is logged when created.
  await flushAll(new D1Driver(env.DB), new D1Driver(env.LEDGER), 0);
}

beforeAll(async () => {
  h = await harness();
  await world();
});

async function allCounts() {
  const out: Record<string, unknown> = {};
  for (const [name, db] of [["main", env.DB], ["ledger", env.LEDGER], ["files", env.FILES!], ["files_2", env.FILES_2!]] as const) {
    const tables = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%'").all<{ name: string }>()).results;
    for (const t of tables) out[`${name}.${t.name}`] = await db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).first("n");
  }
  out.revs = await env.DB.prepare("SELECT (SELECT SUM(rev) FROM tickets) + (SELECT SUM(rev) FROM parties) AS r").first("r");
  return out;
}

describe("signature", () => {
  const path = "/api/backup/manifest";

  it("a correctly signed request is answered", async () => {
    expect((await backupGet(h, path)).status).toBe(200);
    // Inside the 5-minute window either way.
    expect((await backupGet(h, path, { at: h.clock.now() - 4 * 60_000 })).status).toBe(200);
    expect((await backupGet(h, path, { at: h.clock.now() + 4 * 60_000 })).status).toBe(200);
  });

  it("missing, wrong, expired, from the future, for another path, query, host or key: 401", async () => {
    const no = await h.req(path);
    expect(no.status).toBe(401);
    expect(await no.json()).toEqual({ error: "not_signed" });
    const good = await signedHeaders(env.BACKUP_KEY!, "GET", `${ORIGIN}${path}`, h.clock.now());
    const flipped = good[SIG_HEADER]!.replace(/^./, (c) => (c === "0" ? "1" : "0"));
    expect((await h.req(path, { headers: { ...good, [SIG_HEADER]: flipped } })).status).toBe(401);
    expect((await h.req(path, { headers: { [SIG_HEADER]: good[SIG_HEADER]! } })).status).toBe(401);
    // Replayed outside the window.
    const old = await backupGet(h, path, { at: h.clock.now() - 6 * 60_000 });
    expect(old.status).toBe(401);
    expect(await old.json()).toEqual({ error: "stale_request" });
    expect((await backupGet(h, path, { at: h.clock.now() + 6 * 60_000 })).status).toBe(401);
    // The same signature sent again later: refused once the window has passed.
    expect((await h.req(path, { headers: good })).status).toBe(200);
    h.clock.advance(5 * 60_000 + 1000);
    expect((await h.req(path, { headers: good })).status).toBe(401);
    h.clock.advance(-(5 * 60_000 + 1000));
    // Signed for another path or query, used here.
    const other = await signedHeaders(env.BACKUP_KEY!, "GET", `${ORIGIN}/api/backup/schedule`, h.clock.now());
    expect((await h.req(path, { headers: other })).status).toBe(401);
    expect((await h.req(`${path}?counts=1`, { headers: good })).status).toBe(401);
    const page = await signedHeaders(env.BACKUP_KEY!, "GET", `${ORIGIN}/api/backup/rows/main/tickets?limit=5`, h.clock.now());
    expect((await h.req("/api/backup/rows/main/tickets?limit=500", { headers: page })).status).toBe(401);
    expect((await h.req("/api/backup/rows/ledger/change_log?limit=5", { headers: page })).status).toBe(401);
    // Another host (staging vs production) or another key.
    const otherHost = await signedHeaders(env.BACKUP_KEY!, "GET", `https://sahra-staging.example${path}`, h.clock.now());
    expect((await h.req(path, { headers: otherHost })).status).toBe(401);
    expect((await backupGet(h, path, { key: "b3RoZXIta2V5LW90aGVyLWtleS1vdGhlci1rZXktb3RoZXI" })).status).toBe(401);
    // A session cookie is not a signature.
    const g = await guestParty(h);
    expect((await h.req(path, { cookies: { "__Host-sahra_s": g.os.token } })).status).toBe(401);
  });

  it("the signed string covers method, host, path, query and time", () => {
    expect(canonical("get", "Sahra.Test", "/api/backup/rows/main/x", "limit=5", "1700000000"))
      .toBe("SAHRA-BACKUP-1\nGET\nsahra.test\n/api/backup/rows/main/x\nlimit=5\n1700000000");
  });

  it("without BACKUP_KEY (or a key under 32 bytes) every endpoint answers 503, before any database access", async () => {
    for (const key of [undefined, "c2hvcnQ"]) {
      const h2 = await harness({ env: { BACKUP_KEY: key } });
      for (const p of ["/api/backup/schedule", "/api/backup/manifest", "/api/backup/rows/main/tickets", "/api/backup/file/1"]) {
        logs = [];
        const r = await backupGet(h2, p, { key: env.BACKUP_KEY! });
        expect(r.status, p).toBe(503);
        expect(await r.json()).toEqual({ error: "backup_not_configured" });
        const req = parsed("req").at(-1)!;
        expect(req.d1_queries).toBe(0);
      }
    }
  });

  it("an unsigned request never reaches a database", async () => {
    for (const p of ["/api/backup/manifest?counts=1", "/api/backup/rows/ledger/change_log", "/api/backup/file/1"]) {
      logs = [];
      expect((await h.req(p)).status).toBe(401);
      expect(parsed("req").at(-1)!.d1_queries).toBe(0);
      expect(parsed("backup")).toEqual([]);
    }
  });
});

describe("read-only", () => {
  it("every endpoint, every table, every page and every file: zero rows written anywhere", async () => {
    const before = await allCounts();
    logs = [];
    const exp = await exportAll(h, 3);
    expect(exp.files.size).toBeGreaterThan(0);
    expect(exp.purged).toBe(2);
    for (const p of ["/api/backup/schedule", "/api/backup/manifest", "/api/backup/rows/main/nope", "/api/backup/rows/main/sessions", "/api/backup/rows/main/outbox",
      "/api/backup/rows/main/tickets?limit=0", "/api/backup/rows/main/tickets?after=AAAA", "/api/backup/file/files/999999", "/api/backup/file/files/abc"]) {
      expect((await backupGet(h, p)).status, p).not.toBe(500);
    }
    const reqs = parsed("req");
    expect(reqs.length).toBe(exp.requests + 9);
    for (const r of reqs) {
      expect(r.rows_written, String(r.route)).toBe(0);
      expect(r.ledger_rows_written, String(r.route)).toBe(0);
    }
    for (const r of parsed("backup")) expect(r.rows_written).toBe(0);
    expect(await allCounts()).toEqual(before);
  });

  it("excluded tables are not served, unknown ones neither; bad limits and cursors are refused", async () => {
    for (const t of ["sessions", "platform_sessions", "outbox", "d1_migrations", "sqlite_master", "_cf_METADATA"]) {
      expect((await backupGet(h, `/api/backup/rows/main/${t}`)).status, t).toBe(404);
    }
    expect((await backupGet(h, "/api/backup/rows/files/files?limit=1")).status).toBe(200);
    expect((await backupGet(h, "/api/backup/rows/files_2/files?limit=1")).status).toBe(200);
    // A files database that is not bound.
    expect((await backupGet(h, "/api/backup/rows/files_3/files")).status).toBe(404);
    expect((await backupGet(h, "/api/backup/rows/files_9/files")).status).toBe(404);
    expect((await backupGet(h, `/api/backup/rows/main/tickets?limit=${PAGE_MAX + 1}`)).status).toBe(400);
    expect((await backupGet(h, "/api/backup/rows/main/tickets?limit=-1")).status).toBe(400);
    expect((await backupGet(h, "/api/backup/rows/main/tickets?after=WyJ4Il0x")).status).toBe(400);
    // A cursor of the wrong shape (a number where the key is text).
    expect((await backupGet(h, "/api/backup/rows/main/tickets?after=WzFd")).status).toBe(400);
    // Characters outside the signed alphabet are refused (they could be rewritten on the way).
    expect((await backupGet(h, "/api/backup/rows/main/tickets?after=a%2Fb")).status).toBe(401);
    // POST is not part of the protocol.
    const hd = await signedHeaders(env.BACKUP_KEY!, "POST", `${ORIGIN}/api/backup/manifest`, h.clock.now());
    expect((await h.req("/api/backup/manifest", { method: "POST", headers: hd })).status).toBe(404);
  });

  it("a screenshot is served with its SHA-256 and size, never cached", async () => {
    const f = await env.FILES!.prepare("SELECT id, size FROM files WHERE size = ?").bind(BIG).first<{ id: number; size: number }>();
    const r = await backupGet(h, `/api/backup/file/files/${f!.id}`);
    expect(r.status).toBe(200);
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(bytes.length).toBe(BIG);
    expect(r.headers.get("x-sahra-sha256")).toBe(await sha256hexBytes(bigShot));
    expect(r.headers.get("x-sahra-size")).toBe(String(BIG));
    expect(r.headers.get("cache-control")).toBe("no-store");
  });

  it("screenshots of the second database are served from it; purged ones answer 410; an unbound database 404", async () => {
    const live2 = shard2[0]!;
    const r = await backupGet(h, `/api/backup/file/files_2/${live2.id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-sahra-sha256")).toBe(live2.sha);
    expect((await backupGet(h, `/api/backup/file/files/${live2.id}`)).status).toBe(404);
    for (const p of purged) {
      const g = await backupGet(h, `/api/backup/file/${p.db}/${p.id}`);
      expect(g.status).toBe(410);
      expect(((await g.json()) as { error: string }).error).toBe("purged");
    }
    // The list says which are purged, and why.
    const list = (await (await backupGet(h, "/api/backup/rows/files_2/files")).json()) as { rows: { id: number; purged_at: number | null; purged_reason: string | null; size: number }[] };
    const pr = list.rows.find((x) => x.purged_at !== null)!;
    expect(pr.purged_reason).toMatch(/cancelled/);
    expect(pr.size).toBeGreaterThan(0);
    expect((await backupGet(h, `/api/backup/file/files_3/${live2.id}`)).status).toBe(404);
    expect((await backupGet(h, `/api/backup/file/nope/${live2.id}`)).status).toBe(404);
  });
});

describe("paging", () => {
  it("every exported table, every page size: each row exactly once, across page boundaries", async () => {
    for (const limit of [1, 2, 3, 7, 200]) {
      const exp = await exportAll(h, limit);
      for (const spec of SPECS) {
        const want = (await live(spec.db).prepare(selectAll(spec)).all()).results;
        const got = exp.tables.get(`${spec.db}.${spec.table}`)!;
        const keyOf = (r: Record<string, unknown>) => JSON.stringify(spec.key.map((k) => r[k]));
        expect(new Set(got.map(keyOf)).size, `${spec.table} limit ${limit}: duplicates`).toBe(got.length);
        expect(got, `${spec.table} limit ${limit}`).toEqual(want);
      }
    }
  }, 30_000);

  it("a composite key page boundary inside rows that share the first column", async () => {
    const op = (await env.LEDGER.prepare("SELECT op_id FROM intents WHERE action = 'test' LIMIT 1").first<string>("op_id"))!;
    const all: string[] = [];
    let after: string | null = null;
    let pages = 0;
    for (;;) {
      const r = await backupGet(h, `/api/backup/rows/ledger/intents?limit=2${after ? `&after=${after}` : ""}`);
      const p = (await r.json()) as { rows: { op_id: string; entity_id: string }[]; next: string | null };
      all.push(...p.rows.filter((x) => x.op_id === op).map((x) => x.entity_id));
      pages++;
      if (!p.next) break;
      after = p.next;
    }
    expect(all).toEqual(["T0", "T1", "T2", "T3", "T4"]);
    expect(pages).toBeGreaterThan(3);
  });

  it("rows read per page is about the page size (an index range, no table scan)", async () => {
    const n = Number(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets").first("n"));
    expect(n).toBeGreaterThan(5);
    logs = [];
    const first = (await (await backupGet(h, "/api/backup/rows/main/tickets?limit=3")).json()) as { next: string };
    await backupGet(h, `/api/backup/rows/main/tickets?limit=3&after=${first.next}`);
    for (const r of parsed("backup")) {
      expect(r.main_rows_read).toBeLessThanOrEqual(3);
      expect(r.queries).toBe(1);
    }
  });
});

describe("manifest", () => {
  it("lists every table as exported or excluded (with the reason), measured sizes, page size, migrations and counts", async () => {
    logs = [];
    const r = await backupGet(h, "/api/backup/manifest?counts=1");
    const m = (await r.json()) as {
      frequency: string; order: { db: string; table: string }[];
      databases: Record<string, { size_bytes: number; page_size: number; migrations: string[]; tables: { name: string; rows: number }[]; excluded: { name: string; reason: string }[]; unknown: string[] }>;
    };
    expect(m.order.at(-1)).toEqual({ db: "ledger", table: "change_log", key: ["event_id"] });
    expect((m.databases.files_2 as unknown as { binding: string; shard: number })).toMatchObject({ binding: "FILES_2", shard: 2 });
    for (const [name, db] of [["main", env.DB], ["ledger", env.LEDGER], ["files", env.FILES!], ["files_2", env.FILES_2!]] as const) {
      const info = m.databases[name]!;
      expect(info.size_bytes, name).toBeGreaterThan(0);
      expect(info.page_size, name).toBe(4096);
      expect(info.unknown, name).toEqual([]);
      const mig = (await db.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{ name: string }>()).results.map((x) => x.name);
      expect(info.migrations).toEqual(mig);
      for (const t of info.tables) expect(t.rows, `${name}.${t.name}`).toBe(Number(await db.prepare(`SELECT COUNT(*) AS n FROM ${t.name}`).first("n")));
      for (const e of info.excluded) expect(e.reason.length).toBeGreaterThan(3);
      // Every table in the database is accounted for.
      const all = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((x) => x.name).filter((x) => !INTERNAL_TABLE.test(x));
      for (const t of all) expect(SPECS.some((s) => s.db === name && s.table === t) || excludedIn(name).some((s) => s.table === t), `${name}.${t}`).toBe(true);
    }
    // A 1.5 MB screenshot is in the files database, so its measured size is at least that.
    expect(m.databases.files!.size_bytes).toBeGreaterThan(BIG);
    // Without counts, the manifest reads only a few rows.
    logs = [];
    await backupGet(h, "/api/backup/manifest");
    const cheap = parsed("backup").at(-1)!;
    // Listing the schema (tables, migrations) only: grows with the number of tables, not with data.
    expect(Number(cheap.main_rows_read)).toBeLessThan(150);
  });

  it("without the files database the manifest says so and the export skips screenshots", async () => {
    const h2 = await harness({ env: { FILES: undefined, FILES_2: undefined } });
    const m = (await (await backupGet(h2, "/api/backup/manifest")).json()) as { databases: { files: unknown }; order: { db: string }[] };
    expect(m.databases.files).toEqual({ configured: false });
    expect(m.order.some((o) => o.db === "files")).toBe(false);
    expect((await backupGet(h2, "/api/backup/file/files/1")).status).toBe(404);
  });
});

describe("schedule", () => {
  const HOUR = 3600_000;
  const now = Date.UTC(2026, 9, 10, 12);
  const fake = (parties: Record<string, unknown>[], lastAudit: number | null): SqlDriver => ({
    usage: { rows_read: 0, rows_written: 0, queries: 0 },
    all: async (q) => ({ results: (q.text.includes("health_state") ? [{ ok: 1 }] : q.text.includes("guest_erasures") ? [{ at: null }] : q.text.includes("FROM parties") ? parties : lastAudit === null ? [] : [{ at: lastAudit }]) as never[], meta: { changes: 0, rows_read: 0, rows_written: 0 } }),
    batch: async () => { throw new Error("read-only"); },
  });
  const party = (o: Record<string, unknown> = {}) => ({ id: "p", admission_state: "paused", starts_at: null, ends_at: null, disabled_at: null, ...o });

  it("hourly while admission is open, on a party night, or while a party sells; nightly otherwise", async () => {
    expect((await schedule(fake([], null), now)).frequency).toBe("nightly");
    expect((await schedule(fake([party({ admission_state: "open" })], null), now)).frequency).toBe("hourly");
    expect((await schedule(fake([party({ starts_at: now + 10 * HOUR, ends_at: now + 16 * HOUR })], null), now)).frequency).toBe("hourly");
    expect((await schedule(fake([party({ starts_at: now - 20 * HOUR, ends_at: now - 5 * HOUR })], null), now)).frequency).toBe("hourly");
    expect((await schedule(fake([party({ starts_at: now - 30 * HOUR, ends_at: now - 7 * HOUR })], null), now)).frequency).toBe("nightly");
    expect((await schedule(fake([party({ starts_at: now + 13 * HOUR })], now - 30 * HOUR), now)).frequency).toBe("nightly");
    // Selling: a party that is not over, and a change in the last 24 hours.
    const s = await schedule(fake([party({ starts_at: now + 10 * 24 * HOUR })], now - 2 * HOUR), now);
    expect(s).toEqual({ frequency: "hourly", reasons: ["selling: changes in the last 24 hours"], budget_ok: true, guests_erased_at: null });
    expect((await schedule(fake([party({ starts_at: now - 10 * 24 * HOUR })], now - 2 * HOUR), now)).frequency).toBe("nightly");
    // A switched-off party never makes it hourly.
    expect((await schedule(fake([party({ admission_state: "open", disabled_at: 1 })], now - HOUR), now)).frequency).toBe("nightly");
  });

  it("the endpoint reads the parties, one audit row, the health row and the finished guest deletions", async () => {
    logs = [];
    const r = (await (await backupGet(h, "/api/backup/schedule")).json()) as { frequency: string; reasons: string[] };
    expect(r.frequency).toBe("hourly");
    expect(r.reasons.some((x) => x.startsWith("admission open"))).toBe(true);
    const parties = Number(await env.DB.prepare("SELECT COUNT(*) AS n FROM parties").first("n"));
    const erasures = Number(await env.DB.prepare("SELECT COUNT(*) AS n FROM guest_erasures").first("n"));
    expect(Number(parsed("backup").at(-1)!.main_rows_read)).toBeLessThanOrEqual(parties + 2 + Math.max(1, erasures));
  });

  it("says when workstream F's daily budget stops non-essential work (the script then skips hourly backups)", async () => {
    const day = Math.floor(h.clock.now() / 86_400_000);
    const get = async () => ((await (await backupGet(h, "/api/backup/schedule")).json()) as { budget_ok: boolean }).budget_ok;
    expect(await get()).toBe(true);
    await env.DB.prepare("UPDATE health_state SET usage_day = ?, usage_est = ? WHERE id = 'main'").bind(day, BUDGET_STOP_AT).run();
    expect(await get()).toBe(false);
    // Yesterday's estimate does not count.
    await env.DB.prepare("UPDATE health_state SET usage_day = ? WHERE id = 'main'").bind(day - 1).run();
    expect(await get()).toBe(true);
    await env.DB.prepare("UPDATE health_state SET usage_day = 0, usage_est = 0 WHERE id = 'main'").run();
  });
});

describe("export -> restore into fresh databases", () => {
  it("identical rows, identical screenshot bytes (1.5 MB included), and the change log matches the restored database", async () => {
    for (const [db, ms] of [[env.RESTORE_MAIN, env.TEST_MIGRATIONS], [env.RESTORE_LEDGER, env.TEST_LEDGER_MIGRATIONS], [env.RESTORE_FILES, env.TEST_FILES_MIGRATIONS], [env.RESTORE_FILES_2, env.TEST_FILES_MIGRATIONS]] as const) {
      await applyD1Migrations(db, ms);
    }
    // Rows other tests in this file seeded directly; in production every row is logged when created.
    await flushAll(new D1Driver(env.DB), new D1Driver(env.LEDGER), 0);
    const exp = await exportAll(h);
    const t = targets();
    const load = await loadBackup(t, exp.source);
    expect(load.file_problems).toEqual([]);
    expect(load.files).toBe(exp.files.size);
    // Purged before this backup: restored as purged (empty bytes and a tombstone), like the live database.
    expect(load.purged_without_bytes).toBe(2);
    expect(load.purged_restored).toBe(0);
    const cmp = await compareRestore(t, exp.source);
    expect(cmp.blob_mismatches).toEqual([]);
    for (const [k, v] of Object.entries(cmp.tables)) expect(v.different, k).toBe(0);
    expect(cmp.ok).toBe(true);
    // The 1.5 MB screenshot: same bytes as uploaded, hash for hash.
    const big = await env.RESTORE_FILES.prepare("SELECT bytes FROM files WHERE size = ?").bind(BIG).first<{ bytes: ArrayBuffer }>();
    expect(await sha256hexBytes(new Uint8Array(big!.bytes))).toBe(await sha256hexBytes(bigShot));
    const back = new Uint8Array(big!.bytes);
    expect(back.length === bigShot.length && back.every((b, i) => b === bigShot[i])).toBe(true);
    // Same row contents as the live databases, table by table.
    for (const spec of SPECS) {
      const q = `SELECT * FROM ${spec.table} ORDER BY ${spec.key.join(", ")}`;
      expect((await restored(spec.db).prepare(q).all()).results, `${spec.db}.${spec.table}`).toEqual((await live(spec.db).prepare(q).all()).results);
    }
    // Each files database restored into its own database, purge marks included.
    for (const db of ["files", "files_2"] as const) {
      const q = "SELECT id, party_id, ticket_id, reason FROM file_tombstones ORDER BY id";
      expect((await restored(db).prepare(q).all()).results, db).toEqual((await live(db).prepare(q).all()).results);
    }
    const s2 = await env.RESTORE_FILES_2.prepare("SELECT bytes FROM files WHERE id = ?").bind(shard2[0]!.id).first<{ bytes: ArrayBuffer }>();
    expect(await sha256hexBytes(new Uint8Array(s2!.bytes))).toBe(shard2[0]!.sha);
    // The recovery engine: every restored row's rev is in the restored change log with the same state.
    const v = await verify(t.main, t.ledger);
    expect(v.mismatches).toEqual([]);
    expect(v.ok).toBe(true);
    const r = await replay(t.main, t.ledger);
    expect(r.applied).toBe(0);
    expect(r.holds).toEqual([]);
    // Refuses to load twice (only into fresh databases).
    await expect(loadBackup(t, exp.source)).rejects.toThrow(/not empty/);
  }, 30_000);

  it("a change made after the main tables were exported comes back through the change log (ledger exported last)", async () => {
    await emptyRestore();
    // Main tables first...
    const before = await exportAll(h);
    // ...then a scan admits a guest while the backup runs...
    const p = await openParty(h);
    const door = await seedDoor(p.party, h.clock);
    const [tk] = await testTickets(h, p.os, 1);
    expect((await scan(h, door, tk!.qr)).verdict).toBe("admit");
    await flushAll(new D1Driver(env.DB), new D1Driver(env.LEDGER), 0);
    // ...and the ledger, exported last, has it.
    const after = await exportAll(h);
    const mixed = { rows: async (db: string, table: string) => (db === "ledger" ? after : before).tables.get(`${db}.${table}`) ?? [], file: before.source.file };
    const t = { main: new D1Driver(env.RESTORE_MAIN), ledger: new D1Driver(env.RESTORE_LEDGER), files: {} };
    await loadBackup(t, mixed);
    const v = await verify(t.main, t.ledger);
    expect(v.ok).toBe(true);
    const r = await replay(t.main, t.ledger);
    expect(r.applied).toBeGreaterThan(0);
    expect(r.holds).toEqual([]);
    const used = await env.RESTORE_MAIN.prepare("SELECT used_at FROM tickets WHERE id = ?").bind(tk!.id).first("used_at");
    expect(used).not.toBeNull();
  }, 30_000);

  it("a screenshot purged after it was backed up comes back with its bytes from the backup", async () => {
    await emptyRestore();
    const before = await exportAll(h);
    const victim = shard2[0]!;
    const own = await env.DB.prepare("SELECT party_id FROM tickets WHERE id = ?").bind(victim.ticket).first<string>("party_id");
    const os = await seedSession(own!, (await seedOwner(own!)).id, "owner", h.clock);
    expect((await h.req(`/api/tickets/${victim.ticket}/cancel`, api(os, { op: newId() }))).status).toBe(200);
    await purgeOldScreenshots(env, new D1Driver(env.DB), h.clock.now() + 31 * 86_400_000);
    await flushAll(new D1Driver(env.DB), new D1Driver(env.LEDGER), 0);
    const after = await exportAll(h);
    expect(after.tables.get("files_2.files")!.find((r) => r.id === victim.id)!.purged_at).not.toBeNull();
    // The newer backup lists it as purged; the bytes copied earlier are still in "Drive".
    const mixed = { rows: after.source.rows, file: async (db: string, id: number) => (await after.source.file(db, id)) ?? before.source.file(db, id) };
    const t = targets();
    const load = await loadBackup(t, mixed);
    expect(load.file_problems).toEqual([]);
    expect(load.purged_restored).toBe(1);
    expect(load.purged_without_bytes).toBe(2);
    const cmp = await compareRestore(t, mixed);
    expect(cmp.blob_mismatches).toEqual([]);
    expect(cmp.purged).toBe(2);
    const back = await env.RESTORE_FILES_2.prepare("SELECT bytes FROM files WHERE id = ?").bind(victim.id).first<{ bytes: ArrayBuffer }>();
    expect(await sha256hexBytes(new Uint8Array(back!.bytes))).toBe(victim.sha);
    expect(await env.RESTORE_FILES_2.prepare("SELECT COUNT(*) AS n FROM file_tombstones WHERE id = ?").bind(victim.id).first("n")).toBe(0);
  }, 30_000);
});

function targets() {
  return { main: new D1Driver(env.RESTORE_MAIN), ledger: new D1Driver(env.RESTORE_LEDGER), files: { files: new D1Driver(env.RESTORE_FILES), files_2: new D1Driver(env.RESTORE_FILES_2) } };
}

/** Empties the restore databases (children first). */
async function emptyRestore() {
  for (const spec of [...SPECS].reverse()) await restored(spec.db).prepare(`DELETE FROM ${spec.table}`).run();
  for (const db of ["files", "files_2"] as const) await restored(db).prepare("DELETE FROM file_tombstones").run();
}

describe("hourly backups: ledger and screenshot list only", () => {
  it("the manifest for an hourly backup lists the screenshot list and the ledger, never the main tables", async () => {
    const m = (await (await backupGet(h, "/api/backup/manifest?kind=hourly")).json()) as { kind: string; order: { db: string; table: string }[] };
    expect(m.kind).toBe("hourly");
    expect(m.order.map((o) => `${o.db}.${o.table}`)).toEqual(["files.files", "files_2.files", "ledger.party_control", "ledger.intents", "ledger.change_log"]);
    expect(tablesFor("nightly")).toEqual(EXPORTED);
    expect(tablesFor("nightly", ["files", "files_2"])).toEqual(SPECS);
  });
});

describe("POST /api/backup/done", () => {
  const folderAt = (ms: number, prefix = "sahra-backup-") => `${prefix}${new Date(ms).toISOString().slice(0, 13)}${new Date(ms).toISOString().slice(14, 16)}Z`;
  const good = (o: Record<string, unknown> = {}) => ({ kind: "nightly", folder: folderAt(h.clock.now() - 20 * 60_000), rows: 44060, files: 4000, bytes: 812345678, ...o });
  const state = () => env.DB.prepare("SELECT last_backup_at, last_backup_note FROM health_state WHERE id = 'main'").first<{ last_backup_at: number | null; last_backup_note: string | null }>();

  it("records a verified backup: one row written, the backup's start time from the signed folder name", async () => {
    await env.DB.prepare("UPDATE health_state SET last_backup_at = NULL, last_backup_note = NULL WHERE id = 'main'").run();
    logs = [];
    const body = good();
    const r = await backupPost(h, "/api/backup/done", body);
    expect(r.status).toBe(200);
    const at = Math.floor((h.clock.now() - 20 * 60_000) / 60_000) * 60_000;
    expect(await r.json()).toEqual({ recorded: true, last_backup_at: at });
    expect(await state()).toEqual({ last_backup_at: at, last_backup_note: `nightly ${body.folder}: 44060 rows, 4000 screenshots (812345678 bytes)` });
    const req = parsed("req").at(-1)!;
    expect(req.rows_written).toBe(1);
    expect(req.ledger_rows_written).toBe(0);
    // An hourly (ledger) backup only updates the note: last_backup_at tracks FULL backups,
    // so hourly runs cannot keep the "backup too old" alert quiet. An older report never moves it back.
    const later = folderAt(h.clock.now() - 5 * 60_000, "sahra-ledger-");
    expect((await backupPost(h, "/api/backup/done", good({ kind: "hourly", folder: later }))).status).toBe(200);
    expect((await state())!.last_backup_note).toMatch(/^hourly sahra-ledger-/);
    expect((await state())!.last_backup_at).toBe(at);
    const older = (await (await backupPost(h, "/api/backup/done", good({ folder: folderAt(h.clock.now() - 3600_000) }))).json()) as { recorded: boolean };
    expect(older.recorded).toBe(false);
    expect((await state())!.last_backup_note).toMatch(/^hourly sahra-ledger-/);
  });

  it("strict: wrong fields, kinds, folder names, numbers or times are refused, writing nothing", async () => {
    const bad: Record<string, unknown>[] = [
      good({ extra: 1 }), { kind: "nightly", folder: good().folder, rows: 1, files: 1 }, good({ kind: "weekly" }),
      good({ kind: "hourly" }), good({ folder: "sahra-backup-2026-13-01T0000Z" }), good({ folder: "sahra-backup-2026-02-30T0000Z" }),
      good({ folder: "../sahra-backup-2026-10-01T0000Z" }), good({ folder: "x".repeat(40) }), good({ rows: -1 }), good({ files: 1.5 }),
      good({ bytes: "12" }), good({ rows: 2e9 }), good({ folder: folderAt(h.clock.now() + 3600_000) }), good({ folder: folderAt(h.clock.now() - 4 * 86_400_000) }),
    ];
    const before = await state();
    logs = [];
    for (const b of bad) {
      const r = await backupPost(h, "/api/backup/done", b);
      expect(r.status, JSON.stringify(b)).toBe(400);
    }
    expect((await backupPost(h, "/api/backup/done", good(), { contentType: "text/plain" })).status).toBe(400);
    expect((await backupPost(h, "/api/backup/done", { ...good(), pad: "x".repeat(2000) })).status).toBe(413);
    for (const r of parsed("req")) expect(r.rows_written).toBe(0);
    expect(await state()).toEqual(before);
  });

  it("signature covers the body and the method; unsigned, wrong key, or no BACKUP_KEY: nothing written", async () => {
    const before = await state();
    const body = JSON.stringify(good({ folder: folderAt(h.clock.now() - 60_000) }));
    const hd = await signedHeaders(env.BACKUP_KEY!, "POST", `${ORIGIN}/api/backup/done`, h.clock.now(), body);
    const post = (headers: Record<string, string>, b = body) => h.req("/api/backup/done", { method: "POST", body: b, headers: { "content-type": "application/json", ...headers } });
    // The body changed after signing.
    expect((await post(hd, body.replace("44060", "44061"))).status).toBe(401);
    // A GET signature for the same path.
    expect((await post(await signedHeaders(env.BACKUP_KEY!, "GET", `${ORIGIN}/api/backup/done`, h.clock.now()))).status).toBe(401);
    expect((await post({})).status).toBe(401);
    expect((await post(await signedHeaders("b3RoZXIta2V5LW90aGVyLWtleS1vdGhlci1rZXktb3RoZXI", "POST", `${ORIGIN}/api/backup/done`, h.clock.now(), body))).status).toBe(401);
    expect((await backupPost(h, "/api/backup/done", good(), { at: h.clock.now() - 6 * 60_000 })).status).toBe(401);
    const h2 = await harness({ env: { BACKUP_KEY: undefined } });
    expect((await backupPost(h2, "/api/backup/done", good(), { key: env.BACKUP_KEY! })).status).toBe(503);
    expect(await state()).toEqual(before);
    // The correctly signed one goes through.
    expect((await post(hd)).status).toBe(200);
  });
});
