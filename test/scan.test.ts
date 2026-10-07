// Section 12 scanning tests, plus the "Worker killed between the main batch and
// the ledger write" case. Only one successful database redemption per ticket.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Driver } from "../src/db/driver";
import { TicketDb } from "../src/db/tickets";
import { base32, csrfFor, newId, newToken, parseToken, randomBytes, sha256hex } from "../src/lib/crypto";
import { signQr, verifyQr } from "../src/qr";
import { api, harness, openParty, scan, seedDoor, seedParty, seedSession, testTickets, type Harness } from "./helpers";

const E = env as unknown as Record<string, unknown>;
const tdb = () => new TicketDb(new D1Driver(env.DB));

async function ticketRow(id: string) {
  return env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first<Record<string, unknown>>();
}
async function scanRows(ticketId: string) {
  return (await env.DB.prepare("SELECT * FROM scans WHERE ticket_id = ? ORDER BY created_at").bind(ticketId).all()).results;
}
async function ledgerEntries(ticketId: string) {
  return (await env.LEDGER.prepare("SELECT event_id, action, rev FROM change_log WHERE entity = 'ticket' AND entity_id = ? ORDER BY rev")
    .bind(ticketId).all()).results;
}

async function setup(h?: Harness) {
  h ??= await harness();
  const p = await openParty(h);
  const door = await seedDoor(p.party, h.clock);
  return { h, ...p, door };
}

describe("QR codes", () => {
  it("use only QR alphanumeric characters, fit QR version 4-M for the longest party id, and verify", async () => {
    const id = base32(randomBytes(10), 16);
    const longParty = "a".repeat(24);
    const qr = await signQr(E, { partyId: longParty, ticketId: id, version: 999999 });
    expect(qr).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
    // QR version 4 at error correction M holds 90 alphanumeric characters.
    expect(qr.length).toBeLessThanOrEqual(90);
    expect(await verifyQr(E, qr)).toEqual({ partyId: longParty, keyId: 1, ticketId: id, version: 999999 });
  });

  it("reject any change to the code, a code signed for another party, and a retired key id", async () => {
    const id = base32(randomBytes(10), 16);
    const qr = await signQr(E, { partyId: "party-one", ticketId: id, version: 1 });
    for (let i = 0; i < qr.length; i++) {
      const ch = qr[i] === "A" ? "B" : "A";
      expect(await verifyQr(E, qr.slice(0, i) + ch + qr.slice(i + 1)), `position ${i}`).toBeNull();
    }
    const other = await signQr(E, { partyId: "party-two", ticketId: id, version: 1 });
    expect(await verifyQr(E, other.replace("PARTY-TWO", "PARTY-ONE"))).toBeNull();
    expect(await verifyQr(E, qr.replace(`.1${id}.`, `.2${id}.`))).toBeNull(); // key id 2 does not exist
  });
});

describe("redemption", () => {
  it("admits once, with name and people; the ticket, scan row and ledger record agree", async () => {
    const { h, door, os } = await setup();
    const [t] = await testTickets(h, os, 1, 3);
    const v = await scan(h, door, t!.qr);
    expect(v).toMatchObject({ verdict: "admit", people: 3 });
    expect(v.name).toMatch(/^Test guest/);
    const row = await ticketRow(t!.id);
    expect(row).toMatchObject({ used_by: door.id, rev: 2 });
    const scans = await scanRows(t!.id);
    expect(scans).toHaveLength(1);
    expect(scans[0]).toMatchObject({ outcome: "admitted", ticket_rev: 2, staff_id: door.id });
    expect(await ledgerEntries(t!.id)).toEqual([
      { event_id: `ticket:${t!.id}:1`, action: "ticket_created", rev: 1 },
      { event_id: `ticket:${t!.id}:2`, action: "admitted", rev: 2 },
    ]);
    const again = await scan(h, door, t!.qr);
    expect(again).toMatchObject({ verdict: "used", by: expect.stringMatching(/^Door/) });
    expect(again.when).toBe(row!.used_at);
  });

  it("2+ phones scanning the same ticket at the same moment: exactly one admit", async () => {
    const { h, os, party } = await setup();
    const phones = await Promise.all(Array.from({ length: 8 }, () => seedDoor(party, h.clock)));
    for (const t of await testTickets(h, os, 5)) {
      const vs = await Promise.all(phones.map((p) => scan(h, p, t.qr)));
      expect(vs.filter((v) => v.verdict === "admit")).toHaveLength(1);
      expect(vs.filter((v) => v.verdict === "used")).toHaveLength(7);
      expect((await ticketRow(t.id))!.rev).toBe(2);
      expect((await scanRows(t.id)).filter((s) => s.outcome === "admitted")).toHaveLength(1);
    }
  });

  it("lost response, then retry with the same scan id: same outcome, no second redemption", async () => {
    const { h, door, os } = await setup();
    const [t] = await testTickets(h, os);
    const id = newId();
    expect((await scan(h, door, t!.qr, id)).verdict).toBe("admit");
    expect((await scan(h, door, t!.qr, id)).verdict).toBe("admit"); // the stored outcome, not a new admission
    expect((await ticketRow(t!.id))!.rev).toBe(2);
    expect(await scanRows(t!.id)).toHaveLength(1);
    expect(await ledgerEntries(t!.id)).toHaveLength(2);
  });

  it("a denied scan stays denied when retried after the ticket is approved; a NEW scan id is admitted", async () => {
    const { h, door, os, party, owner } = await setup();
    const id = base32(randomBytes(10), 16);
    await tdb().createTicket(null, { id, partyId: party, people: 1, guestName: "P", status: "pending", release: false, now: h.clock.now(), actor: null, op: newId() });
    const qr = await signQr(E, { partyId: party, ticketId: id, version: 1 });
    const scanId = newId();
    expect(await scan(h, door, qr, scanId)).toEqual({ verdict: "stop", reason: "not approved" });
    const sess = { hash: os.hash, partyId: party };
    expect(await tdb().approve(sess, id, h.clock.now(), owner.id, newId())).toBe(true);
    expect(await scan(h, door, qr, scanId)).toEqual({ verdict: "stop", reason: "not approved" });
    expect(await tdb().release(sess, id, h.clock.now(), owner.id, newId())).toBe(true);
    expect(await scan(h, door, qr, scanId)).toEqual({ verdict: "stop", reason: "not approved" });
    expect((await scan(h, door, qr)).verdict).toBe("admit");
  });

  it("a reused scan id with a different ticket, code, scanner or party is rejected, ticket unchanged", async () => {
    const { h, door, os, party, owner } = await setup();
    const [a, b] = await testTickets(h, os, 2);
    const scanId = newId();
    expect((await scan(h, door, a!.qr, scanId)).verdict).toBe("admit");

    // Different ticket.
    expect(await scan(h, door, b!.qr, scanId)).toEqual({ verdict: "stop", reason: "scan id conflict" });
    expect((await ticketRow(b!.id))!.used_scan_id).toBeNull();
    // Different scanner (another phone's session).
    const other = await seedDoor(party, h.clock);
    expect(await scan(h, other, a!.qr, scanId)).toEqual({ verdict: "stop", reason: "scan id conflict" });
    // Different code for the same ticket (new version after reissue of a fresh ticket).
    const [c] = await testTickets(h, os);
    const cid = newId();
    expect(await scan(h, door, c!.qr, cid)).toMatchObject({ verdict: "admit" });
    const d = (await testTickets(h, os))[0]!;
    await tdb().reissue({ hash: os.hash, partyId: party }, d.id, h.clock.now(), owner.id, newId());
    const d2 = await signQr(E, { partyId: party, ticketId: d.id, version: 2 });
    const did = newId();
    expect(await scan(h, door, d.qr, did)).toEqual({ verdict: "stop", reason: "old QR (ticket was reissued)" });
    expect(await scan(h, door, d2, did)).toEqual({ verdict: "stop", reason: "scan id conflict" });
    expect((await ticketRow(d.id))!.used_scan_id).toBeNull();
    // Different party.
    const p2 = await openParty(h);
    const door2 = await seedDoor(p2.party, h.clock);
    const [x] = await testTickets(h, p2.os);
    expect(await scan(h, door2, x!.qr, scanId)).toEqual({ verdict: "stop", reason: "scan id conflict" });
    expect((await ticketRow(x!.id))!.used_scan_id).toBeNull();
    expect((await ticketRow(a!.id))!.rev).toBe(2);
  });

  it("invalid signature, unknown ticket, old version after reissue, cancelled, rejected, not released", async () => {
    const { h, door, os, party, owner } = await setup();
    const sess = { hash: os.hash, partyId: party };
    const [t] = await testTickets(h, os);
    expect(await scan(h, door, t!.qr.slice(0, -1) + (t!.qr.endsWith("0") ? "1" : "0"))).toEqual({ verdict: "stop", reason: "invalid code" });
    expect(await scan(h, door, "not a ticket")).toEqual({ verdict: "stop", reason: "invalid code" });
    const ghost = await signQr(E, { partyId: party, ticketId: base32(randomBytes(10), 16), version: 1 });
    expect(await scan(h, door, ghost)).toEqual({ verdict: "stop", reason: "unknown ticket" });

    const [r1] = await testTickets(h, os);
    await tdb().reissue(sess, r1!.id, h.clock.now(), owner.id, newId());
    expect(await scan(h, door, r1!.qr)).toEqual({ verdict: "stop", reason: "old QR (ticket was reissued)" });
    expect((await scan(h, door, await signQr(E, { partyId: party, ticketId: r1!.id, version: 2 }))).verdict).toBe("admit");

    const [c] = await testTickets(h, os);
    await tdb().cancel(sess, c!.id, h.clock.now(), owner.id, newId());
    expect(await scan(h, door, c!.qr)).toEqual({ verdict: "stop", reason: "not approved" });

    const mk = async (status: "pending" | "approved", release: boolean) => {
      const id = base32(randomBytes(10), 16);
      await tdb().createTicket(null, { id, partyId: party, people: 1, guestName: "x", status, release, now: h.clock.now(), actor: null, op: newId() });
      return { id, qr: await signQr(E, { partyId: party, ticketId: id, version: 1 }) };
    };
    const rej = await mk("pending", false);
    await tdb().reject(sess, rej.id, h.clock.now(), owner.id, newId());
    expect(await scan(h, door, rej.qr)).toEqual({ verdict: "stop", reason: "not approved" });
    const unreleased = await mk("approved", false);
    expect(await scan(h, door, unreleased.qr)).toEqual({ verdict: "stop", reason: "QR not sent yet" });
    // A cancelled ticket can no longer be released or reissued into admittance.
    expect(await tdb().reissue(sess, c!.id, h.clock.now(), owner.id, newId())).toBe(false);
  });

  it("a code for another party is stopped; a scanner without a valid session gets not_signed_in and nothing is written", async () => {
    const { h, door, os } = await setup();
    const p2 = await openParty(h);
    const [foreign] = await testTickets(h, p2.os);
    expect(await scan(h, door, foreign!.qr)).toEqual({ verdict: "stop", reason: "ticket is for another party" });
    const [t] = await testTickets(h, os);
    await env.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id_hash = ?").bind(door.hash).run();
    expect(await scan(h, door, t!.qr)).toEqual({ verdict: "not_signed_in" });
    expect(await scanRows(t!.id)).toHaveLength(0);
    expect((await ticketRow(t!.id))!.used_scan_id).toBeNull();
  });
});

describe("green-screen rule (ledger before green)", () => {
  it("ledger write failure and lost acknowledgement: no green; the retry with the same scan id finishes it", async () => {
    for (const mode of ["fail", "lose_ack"] as const) {
      const { h, door, os } = await setup();
      const [t] = await testTickets(h, os);
      const scanId = newId();
      h.ledger.admissionMode = mode;
      expect(await scan(h, door, t!.qr, scanId), mode).toEqual({ verdict: "recording" });
      expect(await scan(h, door, t!.qr, scanId), mode).toEqual({ verdict: "recording" });
      h.ledger.admissionMode = "ok";
      expect((await scan(h, door, t!.qr, scanId)).verdict, mode).toBe("admit");
      expect((await scan(h, door, t!.qr)).verdict, mode).toBe("used");
      expect((await ticketRow(t!.id))!.rev, mode).toBe(2);
      expect((await ledgerEntries(t!.id)).filter((e) => e.action === "admitted"), mode).toHaveLength(1);
    }
  });

  it("Worker killed after the main batch commits, before the ledger write: same scan id -> record written -> green; never two admits", async () => {
    const { h, door, os, party } = await setup();
    const [t] = await testTickets(h, os);
    const scanId = newId();
    const control = await env.LEDGER.prepare("SELECT pause_number FROM party_control WHERE party_id = ?").bind(party).first<{ pause_number: number }>();
    // The main batch runs and commits, then the Worker dies: no response, no ledger write.
    const r = await tdb().redeem({
      scanId, partyId: party, sessionHash: door.hash, ticketId: t!.id, qrVersion: 1,
      fingerprint: await sha256hex(t!.qr), pauseNumber: control!.pause_number, now: h.clock.now(), op: newId(),
    });
    expect(r.scan?.outcome).toBe("admitted");
    expect((await ledgerEntries(t!.id)).filter((e) => e.action === "admitted")).toHaveLength(0);
    // Another phone scans the same guest meanwhile: used (no second admit).
    const other = await seedDoor(party, h.clock);
    expect((await scan(h, other, t!.qr)).verdict).toBe("used");
    // The original scanner retries with the same scan id.
    expect((await scan(h, door, t!.qr, scanId)).verdict).toBe("admit");
    expect((await ledgerEntries(t!.id)).filter((e) => e.action === "admitted")).toHaveLength(1);
    expect((await scan(h, door, t!.qr, scanId)).verdict).toBe("admit");
    expect((await scanRows(t!.id)).filter((s) => s.outcome === "admitted")).toHaveLength(1);
    expect((await ticketRow(t!.id))!.rev).toBe(2);
  });

  it("a pause between the ledger write and the response: no green, for that scan id ever", async () => {
    const { h, door, os } = await setup();
    const [t] = await testTickets(h, os);
    const scanId = newId();
    h.ledger.afterAdmissionWrite = async () => {
      h.ledger.afterAdmissionWrite = null;
      const r = await h.req("/api/admission", api(os, { action: "pause" }));
      expect(r.status).toBe(200);
    };
    expect(await scan(h, door, t!.qr, scanId)).toEqual({ verdict: "paused" });
    expect((await ledgerEntries(t!.id)).filter((e) => e.action === "admitted")).toHaveLength(1);
    expect(await scan(h, door, t!.qr, scanId)).toEqual({ verdict: "paused" });
    // Reopened: the scan id keeps its old pause_number, so it still never shows green.
    expect((await h.req("/api/admission", api(os, { action: "open" }))).status).toBe(200);
    expect(await scan(h, door, t!.qr, scanId)).toEqual({ verdict: "paused" });
    expect((await scan(h, door, t!.qr)).verdict).toBe("used");
  });

  it("session revoked between attempts: the retry still writes the ledger record, then answers not_signed_in", async () => {
    const { h, door, os } = await setup();
    const [t] = await testTickets(h, os);
    const scanId = newId();
    h.ledger.admissionMode = "fail";
    expect((await scan(h, door, t!.qr, scanId)).verdict).toBe("recording");
    h.ledger.admissionMode = "ok";
    await env.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id_hash = ?").bind(door.hash).run();
    expect(await scan(h, door, t!.qr, scanId)).toEqual({ verdict: "not_signed_in" });
    expect((await ledgerEntries(t!.id)).filter((e) => e.action === "admitted")).toHaveLength(1);
  });

  it("a ticket changed after its admission but before the ledger record (privileged reset): no green", async () => {
    const { h, door, os, party, owner } = await setup();
    const [t] = await testTickets(h, os);
    const scanId = newId();
    h.ledger.admissionMode = "fail";
    expect((await scan(h, door, t!.qr, scanId)).verdict).toBe("recording");
    h.ledger.admissionMode = "ok";
    expect(await tdb().resetAdmission({ hash: os.hash, partyId: party }, t!.id, "guest left and came back", h.clock.now(), owner.id, newId())).toBe(true);
    expect(await scan(h, door, t!.qr, scanId)).toEqual({ verdict: "stop", reason: "ticket changed, scan again" });
    expect((await scan(h, door, t!.qr)).verdict).toBe("admit");
  });
});

describe("admission state", () => {
  it("never-opened party, paused party, and a main-database pause_number that lags the control object: paused", async () => {
    const h = await harness();
    const party = await seedParty();
    const door = await seedDoor(party, h.clock);
    const ownerId = newId();
    await env.DB.prepare("INSERT INTO staff (id, party_id, name, role, google_sub, created_at, logged_rev) VALUES (?, ?, 'O', 'owner', ?, 0, 1)").bind(ownerId, party, `g-${ownerId}`).run();
    const os = await seedSession(party, ownerId, "owner", h.clock);
    const [t] = await testTickets(h, os);
    expect(await scan(h, door, t!.qr)).toEqual({ verdict: "paused" }); // no control object yet

    expect((await h.req("/api/admission", api(os, { action: "open" }))).status).toBe(200);
    expect((await h.req("/api/admission", api(os, { action: "pause" }))).status).toBe(200);
    expect(await scan(h, door, t!.qr)).toEqual({ verdict: "paused" });
    expect((await h.req("/api/admission", api(os, { action: "open" }))).status).toBe(200);

    // Control object paused with a new pause_number, main database not updated (e.g. it failed): paused.
    const c = await env.LEDGER.prepare("SELECT rev, pause_number FROM party_control WHERE party_id = ?").bind(party).first<{ rev: number; pause_number: number }>();
    await env.LEDGER.prepare("UPDATE party_control SET pause_number = pause_number + 1, rev = rev + 1 WHERE party_id = ?").bind(party).run();
    expect(await scan(h, door, t!.qr)).toEqual({ verdict: "paused" });
    expect((await scanRows(t!.id)).map((s) => s.outcome)).toEqual(["paused"]);
    expect(c!.rev).toBeGreaterThan(0);
  });

  it("door staff cannot open or pause admission; the control object only changes by its rev", async () => {
    const { h, door, party } = await setup();
    expect((await h.req("/api/admission", api(door, { action: "pause" }))).status).toBe(403);
    const ledger = h.ledger.inner;
    const c = (await ledger.getControl(party))!;
    expect(await ledger.setControl(party, c.rev + 5, { state: "paused", pause_number: 99 }, 0, null)).toBe(false);
    expect(await ledger.setControl(party, c.rev, { state: "paused", pause_number: c.pause_number + 1 }, 0, null)).toBe(true);
    expect(await ledger.setControl(party, c.rev, { state: "open", pause_number: 0 }, 0, null)).toBe(false);
  });

  it("control object or main database unreachable: cant_verify, never admit", async () => {
    const { h, door, os } = await setup();
    const [t] = await testTickets(h, os);
    h.ledger.controlMode = "fail";
    expect(await scan(h, door, t!.qr)).toEqual({ verdict: "cant_verify" });
    h.ledger.controlMode = "ok";
    expect((await ticketRow(t!.id))!.used_scan_id).toBeNull();
  });
});

describe("rows written per scan", () => {
  it("admit: 2 rows in the main database + 1 in the ledger; denial: 1 + 0", async () => {
    const { h, door, os } = await setup();
    const [t] = await testTickets(h, os);
    const lines: string[] = [];
    const orig = console.log;
    console.log = (m: unknown) => { lines.push(String(m)); };
    try {
      await scan(h, door, t!.qr);
      await scan(h, door, t!.qr);
    } finally {
      console.log = orig;
    }
    const reqs = lines.filter((l) => l.startsWith('{"evt":"req"')).map((l) => JSON.parse(l));
    console.log(JSON.stringify({ evt: "measure", what: "rows_per_scan_local", admit: [reqs[0].rows_written, reqs[0].ledger_rows_written], used: [reqs[1].rows_written, reqs[1].ledger_rows_written] }));
    expect(reqs[0].rows_written).toBe(2);
    expect(reqs[0].ledger_rows_written).toBe(1);
    expect(reqs[1].rows_written).toBe(1);
    expect(reqs[1].ledger_rows_written).toBe(0);
  });
});

describe("staging-only test endpoints", () => {
  it("answer 404 with production's setting (ENABLE_TEST_TICKETS = '0') and create nothing", async () => {
    const h = await harness({ env: { ENABLE_TEST_TICKETS: "0" } });
    const { os, party } = await openParty(h);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n");
    expect((await h.req("/api/test/tickets", api(os, { count: 1 }))).status).toBe(404);
    expect((await h.req("/api/test/door-invite", api(os, {}))).status).toBe(404);
    expect((await h.req("/api/test/revoke-door-access", api(os, {}))).status).toBe(404);
    expect((await h.req("/api/test/ledger-check", { ...api(os), method: "GET" })).status).toBe(404);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n")).toBe(before);
  });
});

describe("staging-only cleanup and ledger check (cloud runs without database access)", () => {
  async function join(h: Harness, owner: { token: string; csrf: string }) {
    const inv = (await (await h.req("/api/test/door-invite", api(owner, {}))).json()) as { token: string; invite_id: string };
    const session = newToken();
    const r = await h.req("/api/invites/consume", {
      method: "POST", headers: { origin: "https://sahra.test", "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ token: inv.token, session }),
    });
    expect(r.status).toBe(200);
    return { inviteId: inv.invite_id, token: session, csrf: await csrfFor(parseToken(session)!) };
  }

  it("ledger check: every admission has its ledger record", async () => {
    const { h, door, os, party } = await setup();
    const tickets = await testTickets(h, os, 3);
    for (const t of tickets) expect((await scan(h, door, t.qr)).verdict).toBe("admit");
    await scan(h, door, tickets[0]!.qr);
    const r = await h.req("/api/test/ledger-check", { ...api(door), method: "GET" });
    expect(await r.json()).toMatchObject({ party, admissions: 3, ledger_records: 3, missing: 0, orphan: 0, tickets_used: 3, ok: true,
      outcomes: { admitted: 3, already_used: 1 } });
  });

  it("ledger check: an admission without its record is reported", async () => {
    const { h, door, os } = await setup();
    const [t] = await testTickets(h, os, 1);
    h.ledger.admissionMode = "fail";
    expect((await scan(h, door, t!.qr)).verdict).toBe("recording");
    h.ledger.admissionMode = "ok";
    const r = (await (await h.req("/api/test/ledger-check", { ...api(door), method: "GET" })).json()) as Record<string, unknown>;
    expect(r).toMatchObject({ admissions: 1, ledger_records: 0, missing: 1, ok: false });
  });

  it("revokes every door invitation and session of the party, logs each revocation, and ends the caller's session last", async () => {
    const { h, os, party } = await setup();
    const a = await join(h, os);
    const b = await join(h, os);
    const open = (await (await h.req("/api/test/door-invite", api(os, {}))).json()) as { invite_id: string };
    const other = await setup();
    const otherDoor = await join(other.h, other.os);

    const r = await h.req("/api/test/revoke-door-access", api(a, {}));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "done", invites_revoked: 3, sessions_ended: 3 });
    for (const sess of [a, b]) expect((await h.req("/api/me", { ...api(sess), method: "GET" })).status).toBe(401);
    expect((await h.req("/api/me", { ...api(os), method: "GET" })).status).toBe(200);
    expect((await other.h.req("/api/me", { ...api(otherDoor), method: "GET" })).status).toBe(200);
    for (const id of [a.inviteId, b.inviteId, open.invite_id]) {
      const row = (await env.DB.prepare("SELECT rev, logged_rev, revoked_at FROM invites WHERE id = ?").bind(id).first<Record<string, number>>())!;
      expect(row.revoked_at).not.toBeNull();
      expect(row.logged_rev).toBe(row.rev);
      const ev = await env.LEDGER.prepare("SELECT action FROM change_log WHERE event_id = ?").bind(`invite:${id}:${row.rev}`).first("action");
      expect(ev).toBe("invite_revoked");
    }
    const audits = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE party_id = ? AND action = 'invite_revoked'").bind(party).first("n");
    expect(audits).toBe(3);
  });

  it("more revocations than one request records: answers pending, and a repeat finishes them", async () => {
    const { h, os } = await setup();
    const a = await join(h, os);
    for (let i = 0; i < 64; i++) expect((await h.req("/api/test/door-invite", api(os, {}))).status).toBe(200);
    const first = await h.req("/api/test/revoke-door-access", api(a, {}));
    expect(first.status).toBe(503);
    expect(await first.json()).toMatchObject({ status: "pending", logged: 60 });
    const second = await h.req("/api/test/revoke-door-access", api(a, {}));
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ status: "done", invites_revoked: 0, change_log_written: 5 });
    const unlogged = await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE rev > logged_rev").first("n");
    expect(unlogged).toBe(0);
    expect((await h.req("/api/me", { ...api(a), method: "GET" })).status).toBe(401);
  });

  it("ledger unreachable: revocations stay pending, the caller keeps its session, and a retry finishes them", async () => {
    const { h, os } = await setup();
    const a = await join(h, os);
    h.ledger.mode = "fail";
    expect((await h.req("/api/test/revoke-door-access", api(a, {}))).status).toBe(503);
    h.ledger.mode = "ok";
    // Its own session is still valid (ended last), so it can retry.
    const r = await h.req("/api/test/revoke-door-access", api(a, {}));
    expect(r.status).toBe(200);
    const row = (await env.DB.prepare("SELECT rev, logged_rev FROM invites WHERE id = ?").bind(a.inviteId).first<Record<string, number>>())!;
    expect(row.logged_rev).toBe(row.rev);
    expect((await h.req("/api/me", { ...api(a), method: "GET" })).status).toBe(401);
  });
});
