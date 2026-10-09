// Cancelling a party and tracking refunds (brainstorm idea 14, migrations/0026):
// owner only; admission is paused first and never reopens; no new requests; paid
// pending and approved tickets are marked "refund due" (free and rejected ones are
// not); a notice to every guest waits in Emails for approval; a retry changes
// nothing more; refunds are ticked "done" by owners and admins, audited, and the
// guest's ticket page shows the state. Sahra never sends money.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPartyListCache } from "../src/routes/guests";
import { api, guestParty, harness, seedSession, signup, viewTicket } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

type Refunds = { refunds: { ticket_id: string; amount: number; state: string }[]; due_count: number; due_amount: number; done_count: number; done_amount: number };

describe("cancel a party", () => {
  it("pauses admission, closes requests, marks paid tickets refund due, prepares the notice; refunds are ticked done", async () => {
    const h = await harness();
    const { party, os, owner } = await guestParty(h);
    const paid = await signup(h, party, { name: "Paid Guest", email: "paid@example.com" });
    const approved = await signup(h, party, { name: "Approved Guest", email: "approved@example.com" });
    const free = await signup(h, party, { name: "Free Guest", email: "free@example.com" });
    const rejected = await signup(h, party, { name: "Rejected Guest", email: "rejected@example.com" });
    await env.DB.prepare("UPDATE tickets SET price = 300 WHERE id IN (?, ?, ?)").bind(paid.body.ticket_id, approved.body.ticket_id, rejected.body.ticket_id).run();
    await env.DB.prepare("UPDATE tickets SET people = 2 WHERE id = ?").bind(approved.body.ticket_id).run();
    await h.req("/api/tickets/approve", api(os, { ids: [approved.body.ticket_id] }));
    await h.req("/api/tickets/reject", api(os, { ids: [rejected.body.ticket_id] }));
    await h.req("/api/admission", api(os, { action: "open" }));

    // An admin cannot cancel; bad bodies are refused.
    const admin = await env.DB.prepare("INSERT INTO staff (id, party_id, name, role, created_at, logged_rev) VALUES (?, ?, 'Admin', 'admin', 0, 1) RETURNING id")
      .bind(crypto.randomUUID(), party).first<{ id: string }>();
    const as = await seedSession(party, admin!.id, "admin", h.clock);
    const op = crypto.randomUUID();
    const body = { op, reason: "The venue cancelled on us.", mark_refunds: true, email_guests: true };
    expect((await h.req("/api/party/cancel", api(as, body))).status).toBe(403);
    expect((await h.req("/api/party/cancel", api(os, { op, reason: "x" }))).status).toBe(400);

    const r = await h.req("/api/party/cancel", api(os, body));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ status: "cancelled", refunds_due: 2, emails_queued: 3 });
    // A retry with the same op changes nothing more.
    expect(await (await h.req("/api/party/cancel", api(os, body))).json()).toEqual({ status: "already", refunds_due: 2, emails_queued: 3 });

    // Admission is paused and cannot be reopened; no new requests.
    const adm = (await (await h.req("/api/admission", api(os, undefined, "GET"))).json()) as { open: boolean };
    expect(adm.open).toBe(false);
    expect(await env.LEDGER.prepare("SELECT state FROM party_control WHERE party_id = ?").bind(party).first("state")).toBe("paused");
    expect((await h.req("/api/admission", api(os, { action: "open" }))).status).toBe(409);
    expect((await signup(h, party)).body.error).toBe("registration_closed");
    const form = (await (await h.req(`/api/guest/parties/${party}`)).json()) as { registration: { cancelled: boolean }; details: { cancelled: { reason: string } } };
    expect(form.registration.cancelled).toBe(true);
    expect(form.details.cancelled.reason).toBe("The venue cancelled on us.");

    // The notice waits for approval in Emails, to every guest with a waiting or approved request (not the rejected one).
    const mails = (await env.DB.prepare("SELECT subject, body_text, status FROM outbox WHERE party_id = ? AND id LIKE 'announce:%'").bind(party).all<{ subject: string; body_text: string; status: string }>()).results;
    expect(mails.length).toBe(3);
    expect(mails.every((m) => m.status === "awaiting_approval" && m.subject.startsWith("Cancelled: ") && m.body_text.includes("The venue cancelled on us."))).toBe(true);

    // Refunds: paid pending and approved only (300 and 2 x 300).
    const list = (await (await h.req("/api/party/refunds", api(os, undefined, "GET"))).json()) as Refunds;
    expect(list).toMatchObject({ due_count: 2, due_amount: 900, done_count: 0 });
    expect(list.refunds.map((x) => x.ticket_id).sort()).toEqual([paid.body.ticket_id, approved.body.ticket_id].sort());
    // The guest sees it.
    expect((await viewTicket(h, paid.body.link!)).body.ticket).toMatchObject({ refund: { state: "due", amount: 300 } });
    expect((await viewTicket(h, free.body.link!)).body.ticket).toMatchObject({ refund: null });

    // An admin ticks one done; audited; the guest sees it; back to due works too.
    expect((await h.req(`/api/party/refunds/${approved.body.ticket_id}`, api(as, { state: "done" }))).status).toBe(200);
    const after = (await (await h.req("/api/party/refunds", api(os, undefined, "GET"))).json()) as Refunds;
    expect(after).toMatchObject({ due_count: 1, due_amount: 300, done_count: 1, done_amount: 600 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'refund_done' AND entity_id = ?").bind(approved.body.ticket_id).first("n")).toBe(1);
    expect((await viewTicket(h, approved.body.link!)).body.ticket).toMatchObject({ refund: { state: "done", amount: 600 } });
    // A free ticket cannot get a refund row; another party's ticket neither.
    expect((await h.req(`/api/party/refunds/${free.body.ticket_id}`, api(os, { state: "due" }))).status).toBe(409);
    const other = await guestParty(h);
    expect((await h.req(`/api/party/refunds/${paid.body.ticket_id}`, api(other.os, { state: "done" }))).status).toBe(409);
    expect(owner.id).toBeTruthy();
  });

  it("without refunds or emails: only cancelled and paused", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const s = await signup(h, party);
    await env.DB.prepare("UPDATE tickets SET price = 100 WHERE id = ?").bind(s.body.ticket_id).run();
    const r = await h.req("/api/party/cancel", api(os, { op: crypto.randomUUID(), reason: null, mark_refunds: false, email_guests: false }));
    expect(await r.json()).toEqual({ status: "cancelled", refunds_due: 0, emails_queued: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id = ?").bind(party).first("n")).toBe(0);
    // The home list shows it as cancelled (a party with a start time).
    await env.DB.prepare("UPDATE parties SET starts_at = ? WHERE id = ?").bind(h.clock.now() + 86_400_000, party).run();
    clearPartyListCache();
    const home = (await (await h.req("/api/guest/parties")).json()) as { parties: { id: string; state: string }[] };
    expect(home.parties.find((p) => p.id === party)?.state).toBe("cancelled");
  });
});
