// The staging-only test-party endpoint used by scripts/load-test.mjs
// (POST /api/test/party) and the "not released" option of /api/test/tickets.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { csrfFor, newToken, parseToken } from "../src/lib/crypto";
import { api, harness, openParty, OutageDriver, scan, seedDoor, testTickets, type Harness } from "./helpers";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
});
afterEach(() => { vi.restoreAllMocks(); OutageDriver.down = { main: false, ledger: false }; });

function lastReq() {
  const l = logs.filter((x) => x.startsWith('{"evt":"req"')).at(-1);
  return JSON.parse(l!) as { rows_read: number; rows_written: number; ledger_rows_read: number; ledger_rows_written: number; d1_queries: number };
}

async function sessionOf(token: string) {
  return { token, csrf: await csrfFor(parseToken(token)!) };
}

async function createParty(h: Harness, caller: { token: string; csrf: string }, session = newToken()) {
  const r = await h.req("/api/test/party", api(caller, { session, name: "Load test 1" }));
  return { r, session, body: (await r.clone().json()) as { party_id?: string; admission?: string; error?: string } };
}

async function counts() {
  const out: Record<string, unknown> = {};
  for (const t of ["parties", "staff", "sessions", "audit"]) out[t] = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first("n");
  for (const t of ["change_log", "party_control"]) out[t] = await env.LEDGER.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first("n");
  return out;
}

describe("POST /api/test/party (staging only)", () => {
  it("creates a party, an owner session for it and opens admission in one call; the party works end to end", async () => {
    const h = await harness();
    const { os } = await openParty(h);
    const { r, session, body } = await createParty(h, os);
    expect(r.status).toBe(200);
    const m = lastReq();
    // Rows per call, used by the load test's estimate (docs/DECISIONS.md, workstream H).
    expect({ written: m.rows_written, ledger_written: m.ledger_rows_written }).toEqual({ written: 15, ledger_written: 3 });
    const party = body.party_id!;
    expect(party).toMatch(/^lt-[0-9a-f]{16}$/);
    expect(body.admission).toBe("open");
    const owner = await sessionOf(session);
    const me = (await (await h.req("/api/me", { ...api(owner), method: "GET" })).json()) as { party: { id: string }; staff: { role: string } };
    expect(me.party.id).toBe(party);
    expect(me.staff.role).toBe("owner");
    expect(await (await h.req("/api/admission", { ...api(owner), method: "GET" })).json()).toMatchObject({ open: true });
    // Logged like any change: party and staff in the change log, audit rows.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM parties WHERE id = ? AND rev = logged_rev").bind(party).first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE party_id = ? AND rev = logged_rev").bind(party).first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT action FROM audit WHERE party_id = ? ORDER BY id").bind(party).all().then((x) => x.results.map((y) => y.action)))
      .toEqual(["party_created", "staff_added", "admission_opened"]);
    // Tickets, a door phone, an admission, the ledger check and the cleanup all work on it.
    const [t] = await testTickets(h, owner, 1);
    const inv = (await (await h.req("/api/test/door-invite", api(owner, {}))).json()) as { token: string };
    const doorTok = newToken();
    expect((await h.req("/api/invites/consume", { method: "POST", headers: { origin: "https://sahra.test", "content-type": "application/json" }, body: JSON.stringify({ token: inv.token, session: doorTok }) })).status).toBe(200);
    const door = await sessionOf(doorTok);
    expect((await scan(h, door, t!.qr)).verdict).toBe("admit");
    expect((await scan(h, owner, t!.qr)).verdict).toBe("used");
    expect(await (await h.req("/api/test/ledger-check", { ...api(owner), method: "GET" })).json()).toMatchObject({ admissions: 1, ledger_records: 1, ok: true });
    expect(await (await h.req("/api/test/revoke-door-access", api(owner, {}))).json()).toMatchObject({ status: "done", sessions_ended: 1 });
    expect((await h.req("/api/admission", api(owner, { action: "pause" }))).status).toBe(200);
    expect((await h.req("/api/auth/logout", api(owner, {}))).status).toBeLessThan(400);
    expect((await h.req("/api/me", { ...api(owner), method: "GET" })).status).toBe(401);
  });

  it("a door session (from an invitation link) may create one", async () => {
    const h = await harness();
    const { party } = await openParty(h);
    const door = await seedDoor(party, h.clock);
    const { r } = await createParty(h, door);
    expect(r.status).toBe(200);
  });

  it("a retry with the same body returns the same party and writes nothing new", async () => {
    const h = await harness();
    const { os } = await openParty(h);
    const first = await createParty(h, os);
    const before = await counts();
    const again = await createParty(h, os, first.session);
    expect(again.r.status).toBe(200);
    expect(again.body.party_id).toBe(first.body.party_id);
    expect(await counts()).toEqual(before);
    expect(lastReq().rows_written).toBe(0);
  });

  it("two requests at once with the same session value: one party, one owner, one session", async () => {
    const h = await harness();
    const { os } = await openParty(h);
    const session = newToken();
    const rs = await Promise.all(Array.from({ length: 6 }, () => createParty(h, os, session)));
    const ids = new Set(rs.map((x) => x.body.party_id));
    expect(ids.size).toBe(1);
    const party = [...ids][0]!;
    expect(rs.every((x) => x.r.status === 200)).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE party_id = ?").bind(party).first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE party_id = ?").bind(party).first("n")).toBe(1);
  });

  it("without a valid session, or with a revoked one, or a malformed session value: nothing is written", async () => {
    const h = await harness();
    const { os } = await openParty(h);
    const before = await counts();
    expect((await h.req("/api/test/party", api({ token: newToken(), csrf: "x" }, { session: newToken() }))).status).toBe(401);
    expect((await h.req("/api/test/party", api(os, { session: "short" }))).status).toBe(400);
    await env.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id_hash = ?").bind(os.hash).run();
    expect((await createParty(h, os)).r.status).toBe(401);
    expect(await counts()).toEqual(before);
    expect(lastReq().rows_written).toBe(0);
  });

  it("answers 404 with production's setting and writes nothing", async () => {
    const h = await harness({ env: { ENABLE_TEST_TICKETS: "0" } });
    const { os } = await openParty(h);
    const before = await counts();
    expect((await createParty(h, os)).r.status).toBe(404);
    expect(await counts()).toEqual(before);
  });

  it("ledger unreachable: the party is created but the answer is pending; a retry with the same body finishes it", async () => {
    const h = await harness();
    const { os } = await openParty(h);
    h.ledger.mode = "fail";
    const first = await createParty(h, os);
    expect(first.r.status).toBe(503);
    expect(first.body).toMatchObject({ error: "not_recorded_yet" });
    h.ledger.mode = "ok";
    const again = await createParty(h, os, first.session);
    expect(again.r.status).toBe(200);
    const party = again.body.party_id!;
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM parties WHERE id = ? AND rev = logged_rev").bind(party).first("n")).toBe(1);
    expect(await (await h.req("/api/admission", { ...api(await sessionOf(first.session)), method: "GET" })).json()).toMatchObject({ open: true });
  });

  it("main database unreachable: 503, nothing confirmed; a retry creates it", async () => {
    const h = await harness();
    const { os } = await openParty(h);
    const session = newToken();
    // The caller's session check itself needs the database: down before the request.
    OutageDriver.down.main = true;
    const first = await createParty(h, os, session);
    expect(first.r.status).toBe(503);
    OutageDriver.down.main = false;
    const again = await createParty(h, os, session);
    expect(again.r.status).toBe(200);
  });
});

describe("POST /api/test/tickets with released: false", () => {
  it("creates approved tickets whose QR was not sent: a scan says stop, not released", async () => {
    const h = await harness();
    const { os, party } = await openParty(h);
    const door = await seedDoor(party, h.clock);
    const r = await h.req("/api/test/tickets", api(os, { count: 2, released: false }));
    const { tickets } = (await r.json()) as { tickets: { qr: string }[] };
    for (const t of tickets) expect(await scan(h, door, t.qr)).toMatchObject({ verdict: "stop", reason: "QR not sent yet" });
    const [ok] = await testTickets(h, os, 1);
    expect((await scan(h, door, ok!.qr)).verdict).toBe("admit");
  });
});

describe("rows per request for the load test's estimate (local, D1 meta)", () => {
  it("measures every request the load test makes", async () => {
    const h = await harness();
    const { os, party } = await openParty(h);
    const other = await openParty(h);
    const door = await seedDoor(party, h.clock);
    const out: Record<string, number[]> = {};
    const take = (k: string) => { const m = lastReq(); out[k] = [m.d1_queries, m.rows_read, m.rows_written, m.ledger_rows_read, m.ledger_rows_written]; };
    const tickets = (await (await h.req("/api/test/tickets", api(os, { count: 20 }))).json()) as { tickets: { qr: string }[] };
    take("tickets_20");
    await h.req("/api/test/tickets", api(os, { count: 20, released: false }));
    const unreleased = ((await (await h.req("/api/test/tickets", api(os, { count: 1, released: false }))).json()) as { tickets: { qr: string }[] }).tickets;
    take("tickets_1");
    const [otherT] = await testTickets(h, other.os, 1);
    const id = crypto.randomUUID();
    const s1 = await h.req("/api/scan", api(door, { scan_id: id, qr: tickets.tickets[0]!.qr }));
    expect(((await s1.json()) as { verdict: string }).verdict).toBe("admit");
    take("scan_admit");
    await h.req("/api/scan", api(door, { scan_id: id, qr: tickets.tickets[0]!.qr }));
    take("scan_retry_same_id");
    await h.req("/api/scan", api(door, { scan_id: crypto.randomUUID(), qr: tickets.tickets[0]!.qr }));
    take("scan_used");
    await h.req("/api/scan", api(door, { scan_id: crypto.randomUUID(), qr: unreleased[0]!.qr }));
    take("scan_not_released");
    await h.req("/api/scan", api(door, { scan_id: crypto.randomUUID(), qr: otherT!.qr }));
    take("scan_wrong_party");
    const inv = (await (await h.req("/api/test/door-invite", api(os, {}))).json()) as { token: string };
    take("door_invite");
    await h.req("/api/invites/consume", { method: "POST", headers: { origin: "https://sahra.test", "content-type": "application/json" }, body: JSON.stringify({ token: inv.token, session: newToken() }) });
    take("join");
    await h.req("/api/test/ledger-check", { ...api(os), method: "GET" });
    take("ledger_check");
    await h.req("/api/admission", { ...api(os), method: "GET" });
    take("admission_get");
    await h.req("/api/test/revoke-door-access", api(os, {}));
    take("revoke_door_access");
    await h.req("/api/admission", api(os, { action: "pause" }));
    take("pause");
    await h.req("/api/auth/logout", api(os, {}));
    take("logout");
    // [queries, main read, main written, ledger read, ledger written]. Writes are fixed
    // per request; reads depend on table sizes (these are a nearly empty database).
    // scripts/load-test.mjs (COST) uses these numbers for its estimate.
    const written = Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [v[2], v[4]]]));
    expect(written).toEqual({
      tickets_20: [80, 20], tickets_1: [4, 1], scan_admit: [2, 1], scan_retry_same_id: [0, 0], scan_used: [1, 0],
      scan_not_released: [1, 0], scan_wrong_party: [0, 0], door_invite: [11, 2], join: [7, 1], ledger_check: [0, 0],
      admission_get: [0, 0], revoke_door_access: [5, 1], pause: [3, 2], logout: [1, 0],
    });
    expect(out.scan_admit).toEqual([1, 18, 2, 2, 1]);
  });
});
