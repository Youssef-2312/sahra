// Guest details deleted 7 days after the party (src/guests/retention.ts,
// migrations/0019_guest_retention.sql): tickets, every change-log copy, rejection
// reasons in the audit log and the party's emails; counts, door history and the
// accepted Terms stay; parties not over by 7 days are untouched; the cleared
// copies still match for recovery; reruns are idempotent and continue a backlog.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Driver } from "../src/db/driver";
import { schedule } from "../src/backup/export";
import { eraseGuestDetails, GUEST_RETENTION } from "../src/guests/retention";
import { newId } from "../src/lib/crypto";
import { sameState } from "../src/recovery/index";
import { clearPartyListCache } from "../src/routes/guests";
import { DELETED_REASON, purgeOldScreenshots, resetUploadTarget, type FilesEnv } from "../src/storage";
import { api, guestParty, harness, signup } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
  resetUploadTarget();
});
afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;
const main = () => new D1Driver(env.DB);
const ledger = () => new D1Driver(env.LEDGER);
const ticket = async (id: string) => (await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first<Record<string, unknown>>())!;
const entries = async (id: string) => (await env.LEDGER.prepare("SELECT rev, state FROM change_log WHERE entity = 'ticket' AND entity_id = ? ORDER BY rev")
  .bind(id).all<{ rev: number; state: string }>()).results.map((e) => ({ rev: e.rev, state: JSON.parse(e.state) as Record<string, unknown> }));
async function endParty(party: string, endedAgo: number, now: number) {
  await env.DB.prepare("UPDATE parties SET starts_at = ?, ends_at = ? WHERE id = ?").bind(now - endedAgo - 6 * 3_600_000, now - endedAgo, party).run();
}

describe("guest details, 7 days after the party", () => {
  it("clears names, emails, answers and rejection reasons everywhere; keeps the counts; recovery still matches", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { form: { screenshot: "optional", questions: [{ id: "q1", label: "Instagram", type: "text", required: false }] } });
    const a = await signup(h, party, { name: "Mona Guest", email: "mona@example.com", answers: { q1: "@mona" } });
    const b = await signup(h, party, { name: "Rami Guest", email: "rami@example.com" });
    expect(a.status).toBe(201);
    await h.req("/api/tickets/reject", api(os, { ids: [b.body.ticket_id], reason: "Rami's payment did not arrive" }));
    // An email for the party (a released ticket would queue one).
    await env.DB.prepare(`INSERT INTO outbox (id, party_id, kind, to_email, ticket_id, subject, body_text, status, created_at)
      VALUES (?, ?, 'ticket_link', 'mona@example.com', ?, 'Your ticket', 'Hi Mona, your link', 'queued', ?)`).bind(`t:${newId()}`, party, a.body.ticket_id, h.clock.now()).run();
    // Another party, over for only 6 days: untouched.
    const { party: recent } = await guestParty(h);
    const c = await signup(h, recent, { name: "Kept Guest", email: "kept@example.com" });

    const now = h.clock.now();
    await endParty(party, 8 * DAY, now);
    await endParty(recent, 6 * DAY, now);
    const beforeA = await ticket(a.body.ticket_id!);
    expect((await entries(a.body.ticket_id!)).length).toBeGreaterThan(0);

    const r = await eraseGuestDetails(main(), ledger(), now);
    expect(r).toMatchObject({ parties: 1, tickets: 2, more: false });
    expect(r.emails).toBe(1);

    for (const id of [a.body.ticket_id!, b.body.ticket_id!]) {
      const t = await ticket(id);
      expect(t).toMatchObject({ guest_name: null, guest_email: null, instagram: null, answers: null, reject_reason: null });
      // Every logged copy is cleared, and the current one still equals the row (recovery's check).
      const es = await entries(id);
      expect(es.length).toBeGreaterThan(0);
      for (const e of es) expect(e.state).toMatchObject({ guest_name: null, guest_email: null, answers: null, reject_reason: null });
      expect(sameState(t, es.find((e) => e.rev === Number(t.rev))!.state)).toBe(true);
    }
    // What stays: status, people, type, price, times, accepted Terms.
    const afterA = await ticket(a.body.ticket_id!);
    for (const k of ["status", "people", "type_id", "price", "created_at", "used_at", "rev", "terms_version", "terms_accepted_at"]) expect(afterA[k]).toEqual(beforeA[k]);
    expect((await ticket(b.body.ticket_id!)).status).toBe("rejected");
    // The rejection reason is gone from the audit log; one audit row records the deletion.
    expect(await env.DB.prepare("SELECT detail FROM audit WHERE entity_type = 'ticket' AND action = 'rejected' AND entity_id = ?").bind(b.body.ticket_id).first("detail")).toBeNull();
    expect(await env.DB.prepare("SELECT detail FROM audit WHERE party_id = ? AND action = 'guest_details_deleted'").bind(party).first("detail"))
      .toBe("2 tickets: name, email, Instagram, answers and rejection reason deleted 7 days after the party");
    // The email: no address or text left, and it will not be sent.
    expect(await env.DB.prepare("SELECT to_email, subject, body_text, status FROM outbox WHERE party_id = ?").bind(party).first())
      .toEqual({ to_email: "", subject: "", body_text: "", status: "cancelled" });
    // Nothing left with a guest's name or email in either database for this party.
    const dump = JSON.stringify([
      (await env.DB.prepare("SELECT * FROM tickets WHERE party_id = ?").bind(party).all()).results,
      (await env.DB.prepare("SELECT * FROM audit WHERE party_id = ?").bind(party).all()).results,
      (await env.DB.prepare("SELECT * FROM outbox WHERE party_id = ?").bind(party).all()).results,
      (await env.LEDGER.prepare("SELECT state FROM change_log WHERE party_id = ?").bind(party).all()).results,
    ]);
    for (const s of ["Mona", "mona@example.com", "@mona", "Rami", "rami@example.com"]) expect(dump).not.toContain(s);

    // The party 6 days after: as it was.
    expect(await ticket(c.body.ticket_id!)).toMatchObject({ guest_name: "Kept Guest", guest_email: "kept@example.com" });
    expect((await entries(c.body.ticket_id!))[0]!.state.guest_name).toBe("Kept Guest");

    // The backup script learns when, to replace older backups that still hold these details.
    expect((await schedule(main(), now)).guests_erased_at).toBe(now);
    // A second run does nothing; a day later the other party is due too.
    expect(await eraseGuestDetails(main(), ledger(), now)).toMatchObject({ parties: 0, tickets: 0 });
    expect(await eraseGuestDetails(main(), ledger(), now + 2 * DAY)).toMatchObject({ parties: 1, tickets: 1 });
  });

  it("continues a large party over several runs; a ticket issued after it was finished is cleared too", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    for (let i = 0; i < 3; i++) expect((await signup(h, party, { name: `Guest ${i}` })).status).toBe(201);
    const now = h.clock.now();
    await endParty(party, 8 * DAY, now);
    const per = GUEST_RETENTION.perRun;
    GUEST_RETENTION.perRun = 2;
    try {
      expect(await eraseGuestDetails(main(), ledger(), now)).toMatchObject({ tickets: 2, parties: 0, more: true });
      expect(await eraseGuestDetails(main(), ledger(), now)).toMatchObject({ tickets: 1, parties: 1, more: false });
    } finally {
      GUEST_RETENTION.perRun = per;
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ? AND guest_name IS NOT NULL").bind(party).first("n")).toBe(0);
    // Staff issue one more afterwards: the party comes back for it.
    h.clock.advance(60_000);
    const issued = await h.req("/api/tickets/issue", api(os, { op: newId(), name: "Late Guest" }));
    expect(issued.status).toBe(201);
    const id = ((await issued.json()) as { ticket_id: string }).ticket_id;
    expect(await eraseGuestDetails(main(), ledger(), h.clock.now())).toMatchObject({ tickets: 1, parties: 1 });
    expect((await ticket(id)).guest_name).toBeNull();
  });

  it("a party without a start time, or still on, is never touched", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const a = await signup(h, party, { name: "No Date" });
    await env.DB.prepare("UPDATE parties SET starts_at = NULL, ends_at = NULL WHERE id = ?").bind(party).run();
    await eraseGuestDetails(main(), ledger(), h.clock.now() + 365 * DAY);
    expect((await ticket(a.body.ticket_id!)).guest_name).toBe("No Date");
  });

  it("payment screenshots follow the same 7 days (a party with only a start time ends 12 hours after it)", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const a = await signup(h, party, { name: "Shot Guest" });
    const now = h.clock.now();
    await env.DB.prepare("UPDATE parties SET starts_at = ?, ends_at = NULL WHERE id = ?").bind(now - 8 * DAY, party).run();
    const r = await purgeOldScreenshots(env as FilesEnv, main(), now);
    expect(r.databases.reduce((n, d) => n + (d.deleted.party_ended ?? 0), 0)).toBeGreaterThanOrEqual(1);
    const key = String((await ticket(a.body.ticket_id!)).screenshot_key);
    const id = Number(key.split(":")[1]);
    const files = [env.FILES, (env as unknown as Record<string, D1Database>).FILES_2].filter(Boolean) as D1Database[];
    const reasons = (await Promise.all(files.map((f) => f.prepare("SELECT reason FROM file_tombstones WHERE id = ? AND party_id = ?").bind(id, party).first("reason")))).filter(Boolean);
    expect(reasons).toEqual([DELETED_REASON.party_ended]);
    expect(DELETED_REASON.party_ended).toBe("screenshot deleted 7 days after the party");
  });
});
