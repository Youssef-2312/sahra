// Changing a guest's email (brainstorm idea 15): the ticket's link and QR are
// replaced, the new link goes to the new address, and the OLD address is told
// (without the new one), so a wrong change does not go unnoticed. Same address or
// a name-only transfer: no notice.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPartyListCache } from "../src/routes/guests";
import { api, guestParty, harness, signup, viewTicket } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

describe("change a guest's email", () => {
  it("replaces the link, emails the new address and tells the old one", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const s = await signup(h, party, { name: "Mona", email: "old@example.com" });
    const r = await h.req(`/api/tickets/${s.body.ticket_id}/transfer`, api(os, { op: crypto.randomUUID(), name: "Mona", email: "new@example.com" }));
    expect(r.status).toBe(200);
    const mails = (await env.DB.prepare("SELECT to_email, subject, body_text FROM outbox WHERE party_id = ? ORDER BY to_email").bind(party)
      .all<{ to_email: string; subject: string; body_text: string }>()).results;
    expect(mails.map((m) => m.to_email)).toEqual(["new@example.com", "old@example.com"]);
    const old = mails.find((m) => m.to_email === "old@example.com")!;
    expect(old.subject).toContain("moved to another email");
    expect(old.body_text).not.toContain("new@example.com");
    expect(old.body_text).toContain("+20 100 000 0001");
    // The old link stops working.
    expect((await viewTicket(h, s.body.link!)).status).toBe(404);

    // A name-only transfer, or the same address again: nobody else is told.
    const t = await signup(h, party, { name: "Rami", email: "rami@example.com" });
    await h.req(`/api/tickets/${t.body.ticket_id}/transfer`, api(os, { op: crypto.randomUUID(), name: "Rami Two" }));
    await h.req(`/api/tickets/${t.body.ticket_id}/transfer`, api(os, { op: crypto.randomUUID(), name: "Rami Three", email: "rami@example.com" }));
    const toRami = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id = ? AND to_email = 'rami@example.com' AND subject LIKE '%moved%'").bind(party).first("n");
    expect(toRami).toBe(0);
  });
});
