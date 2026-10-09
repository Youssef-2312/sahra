// Phase 3 (Checkpoint C): controlled recovery, replay, holds.
//
// A "backup point" is a snapshot of every main-database table; "restore" puts it
// back, as Time Travel would. Changes after the backup point exist only in the
// ledger, and the procedure must bring them back: nothing reopens and nothing
// comes back.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { flushChangeLog } from "../src/changelog";
import { recordIntent } from "../src/changes";
import { Db } from "../src/db";
import { D1Driver, type SqlDriver } from "../src/db/driver";
import { TicketDb } from "../src/db/tickets";
import { csrfFor, newId, newToken, parseToken, sha256hex } from "../src/lib/crypto";
import { D1Ledger } from "../src/ledger";
import { flushAll, newestByEntity, ledgerEntries, reopenedTickets, replay, verify } from "../src/recovery";
import { recover } from "../src/recovery/procedure";
import { resyncReleaseEmails } from "../src/recovery/resync";
import { checkBackup } from "../src/health";
import { api, FlakyLedger, guestParty, harness, openParty, scan, seedDoor, seedOwner, seedSession, signup, testTickets, type Harness } from "./helpers";

const TABLES = ["platform_admins", "organisers", "organiser_invites", "platform_sessions",
  "parties", "staff", "invites", "sessions", "audit", "tickets", "scans", "outbox"];
const DELETE_ORDER = ["sessions", "platform_sessions", "scans", "outbox", "audit", "tickets", "party_flyers", "ticket_types", "invites", "staff", "parties",
  "organiser_invites", "organisers", "platform_admins"];

async function snapshot() {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const t of TABLES) out[t] = (await env.DB.prepare(`SELECT * FROM ${t}`).all()).results;
  return out;
}

async function restore(snap: Record<string, Record<string, unknown>[]>) {
  const stmts: D1PreparedStatement[] = DELETE_ORDER.map((t) => env.DB.prepare(`DELETE FROM ${t}`));
  for (const t of TABLES) {
    for (const r of snap[t]!) {
      const cols = Object.keys(r);
      stmts.push(env.DB.prepare(`INSERT INTO ${t} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).bind(...cols.map((c) => r[c])));
    }
  }
  await env.DB.batch(stmts);
}

const mainDriver = () => new D1Driver(env.DB);
const ledgerDriver = () => new D1Driver(env.LEDGER);
/** Test seeds write rows directly; in production every row is logged when created. */
const complete = () => flushAll(mainDriver(), ledgerDriver(), 0);

/** A ticket change done the way a route does it: intent, main batch, change log. */
async function ticketChange(
  ledger: FlakyLedger, sess: { hash: string; partyId: string }, actor: string, id: string,
  action: "cancel" | "reissue", now: number, opts: { skipMain?: boolean } = {},
) {
  const op = newId();
  await recordIntent(ledger, op, sess.partyId, action === "cancel" ? "cancelled" : "reissued", [{ entity: "ticket", id }], now);
  if (opts.skipMain) return false;
  const ok = await new TicketDb(mainDriver())[action](sess, id, now, actor, op);
  await flushChangeLog(new Db(mainDriver()), ledger, now, [id]);
  return ok;
}

async function world() {
  const h = await harness();
  const p = await openParty(h);
  const door = await seedDoor(p.party, h.clock);
  const tickets = await testTickets(h, p.os, 8);
  const ledger = new FlakyLedger(new D1Ledger(ledgerDriver()));
  const ownerSess = { hash: p.os.hash, partyId: p.party };
  return { h, ...p, door, tickets, ledger, ownerSess };
}

async function reopen(h: Harness, party: string) {
  const owner = await seedOwner(party);
  const os = await seedSession(party, owner.id, "owner", h.clock);
  const r = await h.req("/api/admission", api(os, { action: "open" }));
  expect(r.status).toBe(200);
  return { os, door: await seedDoor(party, h.clock) };
}

/** Tests in one file share the databases: look only at this test's party. */
const mine = <T extends { party_id: string }>(holds: T[], party: string): T[] => holds.filter((x) => x.party_id === party);

function run(snap: Awaited<ReturnType<typeof snapshot>>, h: Harness, main: SqlDriver = mainDriver()) {
  return recover({ main, ledger: ledgerDriver(), now: h.clock.now, restore: () => restore(snap) });
}

describe("controlled recovery: nothing reopens, nothing comes back", () => {
  it("restore after admissions, cancellations, reissues, staff removals, role changes and invitation use", async () => {
    const w = await world();
    const { h, party, os, door, tickets: t, ledger, ownerSess, owner } = w;
    const admin = await seedOwner(party, `sub-${newId()}`, "admin");
    const admin2 = await seedOwner(party, `sub-${newId()}`, "admin");
    expect((await scan(h, door, t[0]!.qr)).verdict).toBe("admit");
    // An invitation used after the backup point, one left unused.
    const inv = (await (await h.req("/api/test/door-invite", api(os, {}))).json()) as { token: string; invite_id: string };
    const unused = (await (await h.req("/api/test/door-invite", api(os, {}))).json()) as { token: string; invite_id: string };

    const snap = await snapshot(); // ---------------- backup point
    h.clock.advance(60_000);

    expect((await scan(h, door, t[1]!.qr)).verdict).toBe("admit");
    expect(await ticketChange(ledger, ownerSess, owner.id, t[2]!.id, "cancel", h.clock.now())).toBe(true);
    expect(await ticketChange(ledger, ownerSess, owner.id, t[3]!.id, "reissue", h.clock.now())).toBe(true);
    expect((await h.req(`/api/staff/${admin.id}/disable`, api(os))).status).toBe(200);
    expect((await h.req(`/api/staff/${admin2.id}/role`, api(os, { role: "owner" }))).status).toBe(200);
    const joinSession = newToken();
    const join = await h.req("/api/invites/consume", {
      method: "POST", headers: { origin: "https://sahra.test", "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ token: inv.token, session: joinSession }),
    });
    expect(join.status).toBe(200);

    h.clock.advance(60_000);
    const report = await run(snap, h);
    expect(report).toMatchObject({ mainChecked: true, mismatchesBefore: 0, finalOk: true });
    expect(mine(report.holds, party)).toEqual([]);
    expect(report.paused).toContain(party);

    // Everyone signs in again: every old session is gone.
    expect((await h.req("/api/me", { ...api(os), method: "GET" })).status).toBe(401);
    expect((await h.req("/api/me", { ...api({ token: joinSession, csrf: await csrfFor(parseToken(joinSession)!) }), method: "GET" })).status).toBe(401);
    // Scanners say paused until an owner reopens.
    const d2 = await seedDoor(party, h.clock);
    expect((await scan(h, d2, t[4]!.qr)).verdict).toBe("paused");

    const { door: d3 } = await reopen(h, party);
    expect((await scan(h, d3, t[0]!.qr)).verdict).toBe("used"); // admitted before the backup point
    expect((await scan(h, d3, t[1]!.qr)).verdict).toBe("used"); // admitted after it: does not reopen
    expect(await scan(h, d3, t[2]!.qr)).toMatchObject({ verdict: "stop", reason: "not approved" }); // cancelled stays cancelled
    expect(await scan(h, d3, t[3]!.qr)).toMatchObject({ verdict: "stop", reason: "old QR (ticket was reissued)" });
    expect((await scan(h, d3, t[4]!.qr)).verdict).toBe("admit");

    const staff = async (id: string) => env.DB.prepare("SELECT role, disabled_at FROM staff WHERE id = ?").bind(id).first<{ role: string; disabled_at: number | null }>();
    expect((await staff(admin.id))!.disabled_at).not.toBeNull(); // removal does not come back
    expect((await staff(admin2.id))!.role).toBe("owner"); // role change kept
    const invite = async (id: string) => env.DB.prepare("SELECT used_at, revoked_at FROM invites WHERE id = ?").bind(id).first<{ used_at: number | null; revoked_at: number | null }>();
    expect((await invite(inv.invite_id))!.used_at).not.toBeNull(); // the used invitation stays used
    expect((await invite(unused.invite_id))!.revoked_at).not.toBeNull(); // unused invitations are revoked
    // ... and cannot be used to join.
    const again = await h.req("/api/invites/consume", {
      method: "POST", headers: { origin: "https://sahra.test", "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ token: unused.token, session: newToken() }),
    });
    expect(again.status).toBe(410);
  });

  it("is idempotent: a second run changes nothing", async () => {
    const w = await world();
    expect((await scan(w.h, w.door, w.tickets[0]!.qr)).verdict).toBe("admit");
    const snap = await snapshot();
    await run(snap, w.h);
    const before = await snapshot();
    const report = await recover({ main: mainDriver(), ledger: ledgerDriver(), now: w.h.clock.now, restore: async () => {} });
    expect(report).toMatchObject({ replayed: 0, held: 0, sessionsRevoked: 0, invitesRevoked: 0, partiesSynced: 0, flushedAfter: 0, finalOk: true });
    const after = await snapshot();
    expect(after.tickets).toEqual(before.tickets);
    expect(after.staff).toEqual(before.staff);
  });
});

describe("replay rule (section 8.2): newest rev wins", () => {
  async function entry(id: string, party: string, rev: number, state: Record<string, unknown>) {
    await env.LEDGER.prepare(`INSERT INTO change_log (event_id, party_id, entity, entity_id, rev, action, logged_at, state)
      VALUES (?, ?, 'ticket', ?, ?, ?, 0, ?)`).bind(`ticket:${id}:${rev}`, party, id, rev, String(state.last_action), JSON.stringify(state)).run();
  }

  it("an older entry written after a newer one never overwrites it", async () => {
    const w = await world();
    const t = (await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(w.tickets[5]!.id).first<Record<string, unknown>>())!;
    const { logged_rev: _l, ...base } = t;
    // Revs 10 and 9: as text "10" sorts before "9", so reading order is not rev order.
    // The ledger receives rev 10 (cancelled) first, then rev 9 (approved, older).
    await entry(t.id as string, w.party, 10, { ...base, rev: 10, status: "cancelled", last_action: "cancelled" });
    await entry(t.id as string, w.party, 9, { ...base, rev: 9, status: "approved", last_action: "approved" });
    expect(newestByEntity(await ledgerEntries(ledgerDriver())).get(`ticket:${t.id}`)!.rev).toBe(10);
    await replay(mainDriver(), ledgerDriver());
    const row = (await env.DB.prepare("SELECT status, rev, logged_rev FROM tickets WHERE id = ?").bind(t.id).first())!;
    expect(row).toEqual({ status: "cancelled", rev: 10, logged_rev: 10 });
    // Replaying again changes nothing.
    const again = await replay(mainDriver(), ledgerDriver());
    expect(again.applied).toBe(0);
  });

  it("a database row newer than the ledger is not overwritten, and is held", async () => {
    const w = await world();
    const id = w.tickets[6]!.id;
    await env.DB.prepare("UPDATE tickets SET rev = rev + 5, status = 'cancelled' WHERE id = ?").bind(id).run();
    const r = await replay(mainDriver(), ledgerDriver());
    expect(r.holds.map((x) => x.id)).toContain(id);
    expect(await env.DB.prepare("SELECT status FROM tickets WHERE id = ?").bind(id).first("status")).toBe("cancelled");
  });
});

describe("main database cannot be checked: unconfirmed changes are held until an owner resolves them", () => {
  /** A main driver whose reads and writes fail (the database unreachable), until `up` is set. */
  function flakyMain() {
    const base = mainDriver();
    const state = { up: false };
    const d: SqlDriver = {
      usage: base.usage,
      all: (q) => (state.up ? base.all(q) : Promise.reject(new Error("D1_ERROR: unreachable"))),
      batch: (qs) => (state.up ? base.batch(qs) : Promise.reject(new Error("D1_ERROR: unreachable"))),
    };
    return { d, state };
  }

  it("a cancel whose record never reached the ledger, and an intent whose change never ran, are both held", async () => {
    const w = await world();
    const { h, party, owner, ownerSess, ledger, tickets: t } = w;
    await complete();
    const snap = await snapshot(); // ---------------- backup point

    // Cancel committed in the main database, but its change-log write failed (shown "pending").
    ledger.mode = "fail";
    await expect(ticketChange(ledger, ownerSess, owner.id, t[2]!.id, "cancel", h.clock.now())).rejects.toThrow();
    ledger.mode = "ok";
    // An intent whose main batch never ran.
    await ticketChange(ledger, ownerSess, owner.id, t[3]!.id, "reissue", h.clock.now(), { skipMain: true });

    const { d, state } = flakyMain();
    const report = await recover({
      main: d, ledger: ledgerDriver(), now: h.clock.now,
      restore: async () => { await restore(snap); state.up = true; },
    });
    expect(report.mainChecked).toBe(false);
    expect(mine(report.holds, party).map((x) => x.id).sort()).toEqual([t[2]!.id, t[3]!.id].sort());
    expect(report.finalOk).toBe(true);

    const { os, door } = await reopen(h, party);
    expect(await scan(h, door, t[2]!.qr)).toMatchObject({ verdict: "stop", reason: "ticket on hold after a database recovery, ask the owner" });
    expect(await scan(h, door, t[3]!.qr)).toMatchObject({ verdict: "stop", reason: "ticket on hold after a database recovery, ask the owner" });
    expect((await scan(h, door, t[4]!.qr)).verdict).toBe("admit");

    // The owner checks and resolves each one (reason required, audited).
    const holds = (await (await h.req("/api/recovery/holds", { ...api(os), method: "GET" })).json()) as { tickets: { id: string }[] };
    expect(holds.tickets.map((x) => x.id).sort()).toEqual([t[2]!.id, t[3]!.id].sort());
    expect((await h.req(`/api/recovery/tickets/${t[3]!.id}/release-hold`, api(os, {}))).status).toBe(400);
    expect((await h.req(`/api/recovery/tickets/${t[3]!.id}/release-hold`, api(os, { reason: "reissue never happened, guest confirmed" }))).status).toBe(200);
    expect((await scan(h, door, t[3]!.qr)).verdict).toBe("admit");
    const audit = await env.DB.prepare("SELECT detail FROM audit WHERE action = 'hold_released' AND entity_id = ?").bind(t[3]!.id).first("detail");
    expect(audit).toBe("reissue never happened, guest confirmed");
    // A hold is released once; the cancelled ticket stays held until the owner decides.
    expect((await h.req(`/api/recovery/tickets/${t[3]!.id}/release-hold`, api(os, { reason: "again" }))).status).toBe(409);
  });

  it("a staff member whose disable was not confirmed is held (disabled) until the owner releases the hold", async () => {
    const w = await world();
    const { h, party, os, ledger } = w;
    const admin = await seedOwner(party, `sub-${newId()}`, "admin");
    await complete();
    const snap = await snapshot();
    // The disable's intent is written, then the change log fails: the main batch committed.
    h.ledger.mode = "fail";
    expect((await h.req(`/api/staff/${admin.id}/disable`, api(os))).status).toBe(503);
    h.ledger.mode = "ok";
    void ledger;

    const { d, state } = flakyMain();
    const report = await recover({ main: d, ledger: ledgerDriver(), now: h.clock.now, restore: async () => { await restore(snap); state.up = true; } });
    expect(mine(report.holds, party)).toEqual([expect.objectContaining({ entity: "staff", id: admin.id })]);
    const row = (await env.DB.prepare("SELECT disabled_at, hold_at FROM staff WHERE id = ?").bind(admin.id).first<Record<string, number | null>>())!;
    expect(row.disabled_at).not.toBeNull();
    expect(row.hold_at).not.toBeNull();

    const { os: os2 } = await reopen(h, party);
    expect((await h.req(`/api/recovery/staff/${admin.id}/release-hold`, api(os2, { reason: "disable was intended" }))).status).toBe(200);
    expect((await env.DB.prepare("SELECT disabled_at FROM staff WHERE id = ?").bind(admin.id).first("disabled_at"))).toBeNull();
  });

  it("missing or different ledger history found before the restore: those tickets are held", async () => {
    const w = await world();
    const id = w.tickets[5]!.id;
    await complete();
    const rev = Number(await env.DB.prepare("SELECT rev FROM tickets WHERE id = ?").bind(id).first("rev"));
    // The ledger's record of the ticket's current rev says something else.
    await env.LEDGER.prepare("UPDATE change_log SET state = json_set(state, '$.status', 'rejected') WHERE event_id = ?").bind(`ticket:${id}:${rev}`).run();
    expect((await verify(mainDriver(), ledgerDriver())).mismatches).toEqual([expect.objectContaining({ entity: "ticket", id, problem: "different" })]);
    const snap = await snapshot();
    const report = await run(snap, w.h);
    expect(report.mainChecked).toBe(false);
    expect(report.holds.map((x) => x.id)).toContain(id);
    expect(await env.DB.prepare("SELECT hold_at IS NOT NULL FROM tickets WHERE id = ?").bind(id).first()).toEqual({ "hold_at IS NOT NULL": 1 });
  });
});


describe("admission invariant: replay never clears an admission", () => {
  it("admitted after the backup point, then party edits and a refused transfer: still used after restore and replay", async () => {
    const w = await world();
    const { h, party, os, door, tickets: t } = w;
    await complete();
    const snap = await snapshot();
    expect((await scan(h, door, t[0]!.qr)).verdict).toBe("admit");
    // Later changes around it: a party edit (logged party entity) and a transfer of the used ticket (refused).
    await env.DB.prepare("UPDATE parties SET description = 'changed', rev = rev + 1, last_action = 'details_edited' WHERE id = ?").bind(party).run();
    await complete();
    const tr = await h.req(`/api/tickets/${t[0]!.id}/transfer`, api(os, { name: "Someone Else", op: newId() }));
    expect(tr.status).not.toBe(200);
    const report = await run(snap, h);
    expect(report.finalOk).toBe(true);
    expect(mine(report.holds, party)).toEqual([]);
    const { door: d2 } = await reopen(h, party);
    expect((await scan(h, d2, t[0]!.qr)).verdict).toBe("used");
  });

  it("an owner's logged admission reset after the admission is honoured: the ticket can be admitted again", async () => {
    const w = await world();
    const { h, party, ownerSess, owner, door, tickets: t } = w;
    await complete();
    const snap = await snapshot();
    expect((await scan(h, door, t[1]!.qr)).verdict).toBe("admit");
    expect(await new TicketDb(mainDriver()).resetAdmission(ownerSess, t[1]!.id, "scanned by mistake", h.clock.now(), owner.id, newId())).toBe(true);
    await flushChangeLog(new Db(mainDriver()), w.ledger, h.clock.now(), [t[1]!.id]);
    const report = await run(snap, h);
    expect(report.finalOk).toBe(true);
    const { door: d2 } = await reopen(h, party);
    expect((await scan(h, d2, t[1]!.qr)).verdict).toBe("admit");
  });

  for (const order of ["newer state logged after the admission", "newer state logged before the admission record"] as const) {
    it(`a change-log state that would clear an admission is never applied; the ticket is held (${order})`, async () => {
      const w = await world();
      const { h, party, door, tickets: t } = w;
      await complete();
      const snap = await snapshot();
      expect((await scan(h, door, t[2]!.qr)).verdict).toBe("admit");
      const row = (await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(t[2]!.id).first<Record<string, unknown>>())!;
      const { logged_rev: _l, ...state } = row;
      // An anomalous newer entry with the admission fields cleared (no reset).
      const bad = { ...state, rev: Number(row.rev) + 1, used_scan_id: null, used_at: null, used_by: null, last_action: "approved" };
      const ins = env.LEDGER.prepare(`INSERT INTO change_log (event_id, party_id, entity, entity_id, rev, action, logged_at, state)
        VALUES (?, ?, 'ticket', ?, ?, 'approved', 0, ?)`).bind(`ticket:${t[2]!.id}:${bad.rev}`, party, t[2]!.id, bad.rev, JSON.stringify(bad));
      if (order === "newer state logged before the admission record") {
        await env.LEDGER.prepare("DELETE FROM change_log WHERE event_id = ?").bind(`ticket:${t[2]!.id}:${row.rev}`).run();
        await ins.run();
        await env.LEDGER.prepare(`INSERT INTO change_log (event_id, party_id, entity, entity_id, rev, action, logged_at, state)
          VALUES (?, ?, 'ticket', ?, ?, 'admitted', 0, ?)`).bind(`ticket:${t[2]!.id}:${row.rev}`, party, t[2]!.id, row.rev, JSON.stringify(state)).run();
      } else {
        await ins.run();
      }
      const report = await run(snap, h);
      expect(mine(report.holds, party).map((x) => x.id)).toContain(t[2]!.id);
      expect(report.finalOk).toBe(true);
      expect(await reopenedTickets(mainDriver(), ledgerDriver())).toEqual([]);
      const { door: d2 } = await reopen(h, party);
      expect((await scan(h, d2, t[2]!.qr)).verdict).not.toBe("admit");
    });
  }
});


describe("emails lost with a restore are rebuilt (audit #5)", () => {
  it("a ticket released after the restore point gets its 'your ticket' email again, once", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const before = await signup(h, party, { email: "before@example.com" });
    const after = await signup(h, party, { email: "after@example.com" });
    for (const id of [before.body.ticket_id!, after.body.ticket_id!]) {
      expect((await h.req("/api/tickets/approve", api(os, { ids: [id] }))).status).toBe(200);
    }
    expect((await h.req("/api/tickets/release", api(os, { ids: [before.body.ticket_id] }))).status).toBe(200);
    await complete();
    const snap = await snapshot();
    const restorePoint = h.clock.now();
    h.clock.advance(60_000);
    expect((await h.req("/api/tickets/release", api(os, { ids: [after.body.ticket_id] }))).status).toBe(200);
    const emailsFor = async (id: string) => Number(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE kind = 'ticket_released' AND ticket_id = ?").bind(id).first("n"));
    expect(await emailsFor(after.body.ticket_id!)).toBe(1);
    h.clock.advance(60_000);

    const report = await recover({ main: mainDriver(), ledger: ledgerDriver(), now: h.clock.now, restore: async () => { await restore(snap); return restorePoint; } });
    expect(report.finalOk).toBe(true);
    // The release came back through replay; its email row did not.
    expect(await env.DB.prepare("SELECT released_at IS NOT NULL AS r FROM tickets WHERE id = ?").bind(after.body.ticket_id).first("r")).toBe(1);
    expect(await emailsFor(after.body.ticket_id!)).toBe(0);

    const env2 = env as unknown as Record<string, unknown> & { PUBLIC_ORIGIN: string };
    expect(await resyncReleaseEmails(env2, mainDriver(), h.clock.now())).toMatchObject({ done: true });
    expect(await emailsFor(after.body.ticket_id!)).toBe(1);
    expect(await emailsFor(before.body.ticket_id!)).toBe(1); // released before the point: its row was restored
    const body = await env.DB.prepare("SELECT body_text FROM outbox WHERE kind = 'ticket_released' AND ticket_id = ?").bind(after.body.ticket_id).first<string>("body_text");
    expect(body).toMatch(/#t=T1\./);
    // Cleared: a second run does nothing.
    expect(await resyncReleaseEmails(env2, mainDriver(), h.clock.now())).toBeNull();
    expect(await emailsFor(after.body.ticket_id!)).toBe(1);
  });
});

describe("hourly backups have their own freshness threshold", () => {
  const H = 3600_000;
  const now = Date.UTC(2026, 9, 31, 22, 0, 0);
  it("while backups are hourly, a missed hourly backup alerts even if the nightly is recent", () => {
    expect(checkBackup({ last_backup_at: now - 5 * H, last_hourly_backup_at: now - 4 * H, last_backup_note: null }, now, true).status).toBe("problem");
    expect(checkBackup({ last_backup_at: now - 5 * H, last_hourly_backup_at: now - 1 * H, last_backup_note: null }, now, true).status).toBe("ok");
    expect(checkBackup({ last_backup_at: now - 5 * H, last_hourly_backup_at: null, last_backup_note: null }, now, false).status).toBe("ok");
    expect(checkBackup({ last_backup_at: now - 27 * H, last_hourly_backup_at: now - 1 * H, last_backup_note: null }, now, true).status).toBe("problem");
  });
});

describe("site-level records (site owners, organisers)", () => {
  it("site owner and organiser sessions end, unused organiser invitations are revoked, and an unconfirmed switch-off is held", async () => {
    const w = await world();
    const { h, party, ledger } = w;
    const now = h.clock.now();
    const org = newId(), inv = newId(), used = newId();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO organisers (id, name, email, google_sub, created_at) VALUES (?, 'Org', 'org@gmail.com', ?, ?)").bind(org, `sub-${org}`, now),
      env.DB.prepare("INSERT INTO organiser_invites (id, organiser_id, created_by, created_at, expires_at) VALUES (?, ?, 'x', ?, ?)").bind(inv, org, now, now + 3600_000),
      env.DB.prepare("INSERT INTO organiser_invites (id, organiser_id, created_by, created_at, expires_at, used_at) VALUES (?, ?, 'x', ?, ?, ?)").bind(used, org, now, now + 3600_000, now),
      env.DB.prepare("INSERT INTO platform_sessions (id_hash, google_sub, created_at, expires_at) VALUES (?, ?, ?, ?)").bind(await sha256hex(newToken()), `sub-${org}`, now, now + 3600_000),
    ]);
    await complete();
    const snap = await snapshot();
    // A party switch-off whose main batch never ran (or whose record was lost).
    await recordIntent(ledger, newId(), party, "party_disabled", [{ entity: "party", id: party }], now);
    const { d, state } = (() => {
      const base = mainDriver();
      const st = { up: false };
      const drv: SqlDriver = { usage: base.usage, all: (q) => (st.up ? base.all(q) : Promise.reject(new Error("D1_ERROR: unreachable"))),
        batch: (qs) => (st.up ? base.batch(qs) : Promise.reject(new Error("D1_ERROR: unreachable"))) };
      return { d: drv, state: st };
    })();
    const report = await recover({ main: d, ledger: ledgerDriver(), now: h.clock.now, restore: async () => { await restore(snap); state.up = true; } });
    expect(report.finalOk).toBe(true);
    expect(mine(report.holds, party)).toEqual([expect.objectContaining({ entity: "party", id: party })]);
    expect(await env.DB.prepare("SELECT disabled_at IS NOT NULL AS off FROM parties WHERE id = ?").bind(party).first("off")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_sessions WHERE revoked_at IS NULL").first("n")).toBe(0);
    const invites = (await env.DB.prepare("SELECT id, revoked_at IS NOT NULL AS revoked FROM organiser_invites WHERE organiser_id = ? ORDER BY id").bind(org).all()).results;
    expect(Object.fromEntries(invites.map((r) => [r.id, r.revoked]))).toEqual({ [inv]: 1, [used]: 0 });
    // Every site-level change is in the change log under "_platform".
    const logged = await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM change_log WHERE party_id = '_platform' AND entity = 'organiser_invite' AND entity_id = ?").bind(inv).first("n");
    expect(logged).toBe(2);
  });
});

describe("maintenance switch", () => {
  it("while recovery runs, every API request answers 503 and writes nothing", async () => {
    const h = await harness({ env: { MAINTENANCE: "1" } });
    const sess = { token: newToken(), csrf: "x" };
    for (const path of ["/api/scan", "/api/invites/consume", "/api/admission"]) {
      const r = await h.req(path, api(sess, { scan_id: newId(), qr: "S1.X" }));
      expect(r.status, path).toBe(503);
      expect(await r.json()).toEqual({ error: "maintenance", retry: true });
    }
    void sha256hex;
  });
});
