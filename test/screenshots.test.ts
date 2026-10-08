// Workstream C follow-up: screenshot capacity (several files databases, 70% rule,
// 600 KB cap), retention (purge with tombstones, orphans), "reject old pending
// requests", and group tickets (one QR admits the whole group at once).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Driver } from "../src/db/driver";
import { dbSizes, runHealth } from "../src/health";
import { dayOf } from "../src/limits";
import {
  DELETED_REASON, FileStore, filesCapacity, MAX_FILE_BYTES, purgeOldScreenshots, resetUploadTarget, RETENTION, type FilesEnv,
} from "../src/storage";
import { newId, newToken } from "../src/lib/crypto";
import { api, guestParty, harness, JPEG, openParty, ORIGIN, scan, seedDoor, seedSiteOwner, signup, viewTicket, type Harness } from "./helpers";

const DAY = 86_400_000;

beforeEach(() => {
  resetUploadTarget();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

/** A files database that reports itself `bytes` big (D1's meta.size_after), otherwise the real one. */
function sized(d: D1Database, bytes: number): D1Database {
  return new Proxy(d, {
    get(t, p) {
      if (p === "prepare") {
        return (q: string) => q === "SELECT 1" ? { all: async () => ({ results: [{ 1: 1 }], meta: { size_after: bytes } }) } : t.prepare(q);
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  });
}
const FULL = 360e6; // past 70% of 500 MB
const files1 = env.FILES!;
const files2 = env.FILES_2!;

async function ticket(id: string) {
  return env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first<Record<string, unknown>>();
}
async function fileRow(d: D1Database, ticketId: string) {
  return d.prepare("SELECT id, size, length(bytes) AS stored, (SELECT reason FROM file_tombstones t WHERE t.id = files.id) AS tomb FROM files WHERE ticket_id = ?")
    .bind(ticketId).first<{ id: number; size: number; stored: number; tomb: string | null }>();
}
const shot = (h: Harness, os: { token: string; csrf: string }, id: string) => h.req(`/api/tickets/${id}/screenshot`, api(os, undefined, "GET"));

describe("screenshot size cap", () => {
  it("600,000 bytes is the server maximum", async () => {
    expect(MAX_FILE_BYTES).toBe(600_000);
    const h = await harness();
    const { party } = await guestParty(h);
    const max = new Uint8Array(MAX_FILE_BYTES);
    max.set(JPEG);
    expect((await signup(h, party, { screenshot: max })).status).toBe(201);
    const over = new Uint8Array(MAX_FILE_BYTES + 1);
    over.set(JPEG);
    expect((await signup(h, party, { screenshot: over })).status).toBe(413);
  });
});

describe("several files databases", () => {
  it("uploads go to the first database under 70%; the key names it and reads route by it", async () => {
    const h = await harness({ env: { FILES: sized(files1, FULL), FILES_2: files2 } as never });
    const { party, os } = await guestParty(h);
    const s = await signup(h, party, { screenshot: JPEG });
    expect(s.status).toBe(201);
    const t = await ticket(s.body.ticket_id!);
    expect(t!.screenshot_key).toMatch(/^f2:\d+$/);
    expect(await fileRow(files2, t!.id as string)).toMatchObject({ size: JPEG.length, tomb: null });
    expect(await fileRow(files1, t!.id as string)).toBeNull();
    const r = await shot(h, os, t!.id as string);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(JPEG);
  });

  it("only FILES configured: works as before; keys written before (\"1:<id>\", a bare id) still mean FILES", async () => {
    const h = await harness({ env: { FILES_2: undefined } as never });
    const { party, os } = await guestParty(h);
    const s = await signup(h, party, { screenshot: JPEG });
    const id = s.body.ticket_id!;
    const key = String((await ticket(id))!.screenshot_key);
    expect(key).toMatch(/^f1:\d+$/);
    const n = key.slice(3);
    for (const old of [`1:${n}`, n]) {
      await env.DB.prepare("UPDATE tickets SET screenshot_key = ? WHERE id = ?").bind(old, id).run();
      expect((await shot(h, os, id)).status, old).toBe(200);
    }
  });

  it("every database past 70%: sign-up with a screenshot answers 503 uploads_full and writes nothing; health says so", async () => {
    const e = { FILES: sized(files1, FULL), FILES_2: sized(files2, 400e6) };
    const h = await harness({ env: e as never });
    const { party } = await guestParty(h, { form: { questions: [], screenshot: "optional" } });
    const s = await signup(h, party, { screenshot: JPEG });
    expect([s.status, s.body.error]).toEqual([503, "uploads_full"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n")).toBe(0);
    const form = (await (await h.req(`/api/guest/parties/${party}`)).json()) as { uploads: boolean };
    expect(form.uploads).toBe(false);
    // Without a screenshot (optional here) sign-up still works.
    expect((await signup(h, party, { screenshot: null })).status).toBe(201);

    const cap = await filesCapacity(e);
    expect(cap).toMatchObject({ state: "full", writable: null });
    expect(cap.databases.map((d) => [d.binding, d.full])).toEqual([["FILES", true], ["FILES_2", true]]);
    expect(await filesCapacity({})).toMatchObject({ state: "not_configured", writable: null });
    const sizes = await dbSizes({ DB: env.DB, LEDGER: env.LEDGER, ...e });
    expect(sizes).toMatchObject({ files: FULL, files_2: 400e6 });
    expect(await dbSizes({ DB: env.DB, LEDGER: env.LEDGER, FILES: files1 })).not.toHaveProperty("files_2");
  });
});

describe("retention", () => {
  async function stored(h: Harness, party: string) {
    const s = await signup(h, party, { screenshot: JPEG });
    expect(s.status).toBe(201);
    return s.body.ticket_id!;
  }

  it("deletes screenshots 30 days after the party, rejection or cancellation, and orphans after 1 day; keeps a tombstone", async () => {
    const h = await harness();
    const now = h.clock.now();
    const ended = await guestParty(h);
    const current = await guestParty(h);
    const a = await stored(h, ended.party);
    const keep = await stored(h, current.party);
    const rejOld = await stored(h, current.party);
    const rejNew = await stored(h, current.party);
    const canOld = await stored(h, current.party);
    await h.req("/api/tickets/reject", api(current.os, { ids: [rejOld, rejNew], reason: "no payment" }));
    await h.req(`/api/tickets/${canOld}/cancel`, api(current.os, { op: newId() }));
    expect((await ticket(canOld))!.cancelled_at).toBe(now);
    await env.DB.prepare("UPDATE parties SET ends_at = ? WHERE id = ?").bind(now - 31 * DAY, ended.party).run();
    await env.DB.prepare("UPDATE tickets SET rejected_at = ? WHERE id = ?").bind(now - 31 * DAY, rejOld).run();
    await env.DB.prepare("UPDATE tickets SET rejected_at = ? WHERE id = ?").bind(now - 10 * DAY, rejNew).run();
    await env.DB.prepare("UPDATE tickets SET cancelled_at = ? WHERE id = ?").bind(now - 31 * DAY, canOld).run();
    // Orphans: stored for sign-ups that never became tickets (e.g. the party was full).
    const store = new FileStore(new D1Driver(files1), 1);
    const orphanOld = Math.floor(Math.random() * 1e12) + 1;
    const orphanNew = orphanOld + 1;
    await store.put({ id: orphanOld, partyId: current.party, ticketId: "ORPHAN0000000001", type: "image/jpeg", bytes: JPEG, now: now - 2 * DAY });
    await store.put({ id: orphanNew, partyId: current.party, ticketId: "ORPHAN0000000002", type: "image/jpeg", bytes: JPEG, now: now - 3600_000 });

    const before = (await ticket(a))!;
    const rep = await purgeOldScreenshots(env as FilesEnv, new D1Driver(env.DB), now);
    console.error(JSON.stringify({ evt: "measure", what: "screenshot_purge_local", ...rep }));
    const deleted = rep.databases.find((d) => d.shard === 1)!.deleted;
    expect(deleted).toMatchObject({ party_ended: 1, rejected: 1, cancelled: 1, orphan: 1 });
    for (const [id, reason] of [[a, DELETED_REASON.party_ended], [rejOld, DELETED_REASON.rejected], [canOld, DELETED_REASON.cancelled]] as const) {
      expect(await fileRow(files1, id), id).toMatchObject({ size: JPEG.length, stored: 0, tomb: reason });
    }
    for (const id of [keep, rejNew]) expect(await fileRow(files1, id), id).toMatchObject({ stored: JPEG.length, tomb: null });
    expect(await fileRow(files1, "ORPHAN0000000001")).toMatchObject({ stored: 0, tomb: DELETED_REASON.orphan });
    expect(await fileRow(files1, "ORPHAN0000000002")).toMatchObject({ stored: JPEG.length, tomb: null });
    // The main database is not touched (the ticket keeps its rev and key).
    expect(await ticket(a)).toEqual(before);

    // The queue explains it.
    const r = await shot(h, ended.os, a);
    expect(r.status).toBe(410);
    expect(await r.json()).toEqual({ error: "screenshot_deleted", message: "screenshot deleted 30 days after the party (kept in the Drive backup)" });
    expect((await shot(h, current.os, keep)).status).toBe(200);

    // A second run deletes nothing more.
    const again = await purgeOldScreenshots(env as FilesEnv, new D1Driver(env.DB), now);
    expect(again.databases.find((d) => d.shard === 1)!.deleted).toEqual({});

    // A retried sign-up whose orphan was purged gets its file back.
    await store.put({ id: orphanOld, partyId: current.party, ticketId: "ORPHAN0000000001", type: "image/jpeg", bytes: JPEG, now });
    expect(await fileRow(files1, "ORPHAN0000000001")).toMatchObject({ stored: JPEG.length, tomb: null });
  });

  it("is bounded per run; the next run continues", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    for (let i = 0; i < 3; i++) await signup(h, party, { screenshot: JPEG });
    await env.DB.prepare("UPDATE parties SET ends_at = ? WHERE id = ?").bind(h.clock.now() - 40 * DAY, party).run();
    const per = RETENTION.perRun;
    (RETENTION as { perRun: number }).perRun = 2;
    try {
      const r1 = await purgeOldScreenshots(env as FilesEnv, new D1Driver(env.DB), h.clock.now());
      expect(r1.databases[0]).toMatchObject({ more: true });
      expect(Object.values(r1.databases[0]!.deleted).reduce((x, y) => x + y, 0)).toBe(2);
      const r2 = await purgeOldScreenshots(env as FilesEnv, new D1Driver(env.DB), h.clock.now());
      expect(r2.databases[0]!.deleted.party_ended).toBeGreaterThanOrEqual(1);
    } finally {
      (RETENTION as { perRun: number }).perRun = per;
    }
    const live = await files1.prepare("SELECT COUNT(*) AS n FROM files f WHERE party_id = ? AND NOT EXISTS (SELECT 1 FROM file_tombstones d WHERE d.id = f.id)").bind(party).first("n");
    expect(live).toBe(0);
  });

  it("the daily health run calls it (and a failure does not stop the checks)", async () => {
    await seedSiteOwner();
    const now = Date.UTC(2026, 9, 20, 7, 0, 0);
    await env.DB.prepare("UPDATE health_state SET lease_until = 0, lease_op = NULL, daily_day = ?, admissions_to = ? WHERE id = 'main'")
      .bind(dayOf(now) - 1, now).run();
    const calls: number[] = [];
    const base = { main: new D1Driver(env.DB), ledger: new D1Driver(env.LEDGER), now: () => now, sizes: async () => ({ main: 1, ledger: 1, files: 1 }),
      maintenance: false, emailConfigured: true, origin: ORIGIN };
    const r = await runHealth({ ...base, purgeScreenshots: async (t) => { calls.push(t); return purgeOldScreenshots(env as FilesEnv, new D1Driver(env.DB), t); } });
    expect(r.daily).toBe(true);
    expect(calls).toEqual([now]);
    expect(r.screenshots_purged).toMatchObject({ databases: expect.any(Array) });
    // Not daily any more today: not called again.
    await env.DB.prepare("UPDATE health_state SET lease_until = 0 WHERE id = 'main'").run();
    await runHealth({ ...base, now: () => now + 15 * 60_000, purgeScreenshots: async (t) => { calls.push(t); throw new Error("x"); } });
    expect(calls).toHaveLength(1);
    // A failing purge on a daily run is logged; the run still finishes.
    await env.DB.prepare("UPDATE health_state SET lease_until = 0, daily_day = ? WHERE id = 'main'").bind(dayOf(now) - 1).run();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const failed = await runHealth({ ...base, purgeScreenshots: async () => { throw new Error("files down"); } });
    expect(failed.screenshots_purged).toBe("error");
    expect(failed.checks).toBeDefined();
  });

  it("health: every files database past 70% is reported as uploads closed", async () => {
    await seedSiteOwner();
    const now = Date.UTC(2026, 9, 21, 3, 0, 0);
    await env.DB.prepare("UPDATE health_state SET lease_until = 0, lease_op = NULL, daily_day = ?, admissions_to = ? WHERE id = 'main'").bind(dayOf(now), now).run();
    const deps = { main: new D1Driver(env.DB), ledger: new D1Driver(env.LEDGER), now: () => now, maintenance: false, emailConfigured: true, origin: ORIGIN };
    const r = await runHealth({ ...deps, sizes: async () => ({ main: 1e6, ledger: 1e6, files: FULL, files_2: FULL }) });
    expect(r.checks!.db_size).toBe("problem");
    const row = await env.DB.prepare("SELECT summary FROM health_checks WHERE id = 'db_size'").first<{ summary: string }>();
    expect(row!.summary).toContain("screenshot uploads are closed");
    await env.DB.prepare("UPDATE health_state SET lease_until = 0 WHERE id = 'main'").run();
    await runHealth({ ...deps, now: () => now + 15 * 60_000, sizes: async () => ({ main: 1e6, ledger: 1e6, files: FULL, files_2: 1e6 }) });
    const row2 = await env.DB.prepare("SELECT summary FROM health_checks WHERE id = 'db_size'").first<{ summary: string }>();
    expect(row2!.summary).not.toContain("screenshot uploads are closed");
  });
});

describe("reject old pending requests", () => {
  it("rejects pending requests older than N hours in bounded batches, with the reason the guest sees; places are freed", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { capacity: 30 });
    const old: { id: string; link: string }[] = [];
    for (let i = 0; i < 22; i++) { const s = await signup(h, party); old.push({ id: s.body.ticket_id!, link: s.body.link! }); }
    const approved = (await signup(h, party)).body.ticket_id!;
    await h.req("/api/tickets/approve", api(os, { ids: [approved] }));
    // Make them 5 hours old (the owner's test session lasts an hour, so the clock stays).
    await env.DB.prepare("UPDATE tickets SET created_at = created_at - ? WHERE party_id = ?").bind(5 * 3600_000, party).run();
    const fresh = (await signup(h, party)).body.ticket_id!;
    for (const bad of [{ hours: 0, reason: "x" }, { hours: 721, reason: "x" }, { hours: 4 }, { hours: 4, reason: "  " }, { hours: 1.5, reason: "x" }]) {
      expect((await h.req("/api/tickets/reject-stale", api(os, bad))).status, JSON.stringify(bad)).toBe(400);
    }
    const r1 = await (await h.req("/api/tickets/reject-stale", api(os, { hours: 4, reason: "Payment not received in time" }))).json();
    expect(r1).toEqual({ rejected: 20, remaining: 2 });
    const r2 = await (await h.req("/api/tickets/reject-stale", api(os, { hours: 4, reason: "Payment not received in time" }))).json();
    expect(r2).toEqual({ rejected: 2, remaining: 0 });
    for (const t of old) expect((await ticket(t.id))!).toMatchObject({ status: "rejected", reject_reason: "Payment not received in time", logged_rev: 2 });
    expect((await ticket(approved))!.status).toBe("approved");
    expect((await ticket(fresh))!.status).toBe("pending");
    expect((await viewTicket(h, old[0]!.link)).body.ticket).toMatchObject({ status: "rejected", reject_reason: "Payment not received in time" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'rejected' AND party_id = ?").bind(party).first("n")).toBe(22);
    expect(await env.DB.prepare("SELECT n FROM party_usage WHERE party_id = ? AND kind = 'reject_stale'").bind(party).first("n")).toBe(2);
    // Places freed at once: 1 approved + 1 pending held of 30.
    const f = (await (await h.req(`/api/guest/parties/${party}`)).json()) as { places_left: number };
    expect(f.places_left).toBe(28);
    const door = await seedDoor(party, h.clock);
    expect((await h.req("/api/tickets/reject-stale", api(door, { hours: 1, reason: "x" }))).status).toBe(403);
  });
});

describe("group tickets", () => {
  it("one QR admits the whole group at once: admit with people = 3, then used; the page and the email say so", async () => {
    const h = await harness();
    const { party, os } = await openParty(h);
    await env.DB.prepare("UPDATE parties SET max_people_per_ticket = 4 WHERE id = ?").bind(party).run();
    const door = await seedDoor(party, h.clock);
    const s = await signup(h, party, { people: 3, screenshot: JPEG, signup: newToken() });
    expect(s.status).toBe(201);
    const id = s.body.ticket_id!;
    await h.req("/api/tickets/approve", api(os, { ids: [id] }));
    await h.req("/api/tickets/release", api(os, { ids: [id] }));
    const page = await viewTicket(h, s.body.link!);
    expect((page.body.ticket as Record<string, unknown>).group_note).toBe("This QR admits 3 people together; arrive together.");
    const mail = await env.DB.prepare("SELECT body_text FROM outbox WHERE ticket_id = ? AND kind = 'ticket_released'").bind(id).first<{ body_text: string }>();
    expect(mail!.body_text).toContain("This QR admits 3 people together; arrive together.");
    const qr = page.body.ticket!.qr!;
    expect(await scan(h, door, qr)).toMatchObject({ verdict: "admit", people: 3 });
    expect(await scan(h, door, qr)).toMatchObject({ verdict: "used" });
    // A single-person ticket has no group note.
    const one = await signup(h, party, { people: 1, screenshot: JPEG });
    expect((((await viewTicket(h, one.body.link!)).body.ticket) as Record<string, unknown>).group_note).toBeNull();
  });
});
