// Request reference and expected review time (brainstorm idea 15): the guest sees
// "SAH-" and 6 characters after asking and on the ticket page, staff find the
// request by it (it never opens a ticket), and the organiser's review time line
// is shown to guests.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPartyListCache } from "../src/routes/guests";
import { api, guestParty, harness, signup, viewTicket } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

describe("request reference and review time", () => {
  it("the reference identifies a request to staff; the review time is shown to guests", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    expect((await h.req("/api/party/details", api(os, { review_time: "x".repeat(81) }))).status).toBe(400);
    expect((await h.req("/api/party/details", api(os, { review_time: "Usually within 24 hours" }))).status).toBe(200);

    const s = await signup(h, party, { name: "Ref Guest" });
    const ref = (s.body as { reference?: string }).reference!;
    expect(ref).toBe(`SAH-${s.body.ticket_id!.slice(0, 6)}`);
    const page = (await viewTicket(h, s.body.link!)).body as { ticket: { reference: string }; party: { review_time: string } };
    expect(page.ticket.reference).toBe(ref);
    expect(page.party.review_time).toBe("Usually within 24 hours");
    const form = (await (await h.req(`/api/guest/parties/${party}`)).json()) as { details: { review_time: string } };
    expect(form.details.review_time).toBe("Usually within 24 hours");

    for (const q of [ref, ref.toLowerCase(), ref.replace("-", "")]) {
      const r = (await (await h.req(`/api/tickets/search?q=${encodeURIComponent(q)}`, api(os, undefined, "GET"))).json()) as { tickets: { id: string }[] };
      expect(r.tickets.map((x) => x.id), q).toEqual([s.body.ticket_id]);
    }
    // Another party's staff never find it.
    const other = await guestParty(h);
    const none = (await (await h.req(`/api/tickets/search?q=${ref}`, api(other.os, undefined, "GET"))).json()) as { tickets: unknown[] };
    expect(none.tickets).toEqual([]);
  });
});
