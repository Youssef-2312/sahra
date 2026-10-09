// The organiser's support contact (brainstorm idea 16, migrations/0023): a phone
// or WhatsApp number is required before guests can ask for tickets; it is shown
// on the party page, the guest's ticket page and to door staff; its format is
// checked; the email and availability line are optional.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPartyListCache } from "../src/routes/guests";
import { cleanPhone } from "../src/party/input";
import { api, guestParty, harness, signup, viewTicket } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

describe("support contact", () => {
  it("accepts phone numbers as people type them, and refuses what is not one", () => {
    for (const ok of ["+20 100 000 0000", "01000000000", "(02) 2345-6789", "+44 20 7946 0958"]) expect(cleanPhone(ok)).toBe(ok);
    expect(cleanPhone("  +20   100  000 0000 ")).toBe("+20 100 000 0000");
    for (const bad of ["12345", "call me", "+20+111", "1".repeat(21), "010 0000 0000 ext 2", 20111999]) expect(cleanPhone(bad)).toBeUndefined();
    expect(cleanPhone("")).toBeNull();
  });

  it("no number: requests stay closed; with one, they open and every guest view shows it", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    await env.DB.prepare("UPDATE parties SET support_phone = NULL WHERE id = ?").bind(party).run();
    const form = (await (await h.req(`/api/guest/parties/${party}`)).json()) as { registration: { state: string; needs_contact: boolean }; details: { support: unknown } };
    expect(form.registration).toMatchObject({ state: "not_open_yet", needs_contact: true });
    expect(form.details.support).toBeNull();
    expect((await signup(h, party)).body.error).toBe("registration_not_open");

    // The organiser sets it in Settings (format checked).
    expect((await h.req("/api/party/details", api(os, { support_phone: "not a number" }))).status).toBe(400);
    expect((await h.req("/api/party/details", api(os, { support_email: "nope" }))).status).toBe(400);
    const set = await h.req("/api/party/details", api(os, { support_phone: "+20 100 000 0000", support_email: "Host@Example.com", support_note: "Available 6pm to midnight" }));
    expect(set.status).toBe(200);
    expect(((await set.json()) as { party: Record<string, unknown> }).party).toMatchObject({ support_phone: "+20 100 000 0000", support_email: "host@example.com" });

    const open = (await (await h.req(`/api/guest/parties/${party}`)).json()) as { registration: { state: string }; details: { support: unknown } };
    expect(open.registration.state).toBe("open");
    const contact = { phone: "+20 100 000 0000", email: "host@example.com", note: "Available 6pm to midnight" };
    expect(open.details.support).toEqual(contact);
    const s = await signup(h, party);
    expect(s.status).toBe(201);
    expect((await viewTicket(h, s.body.link!)).body.party).toMatchObject({ support: contact });

    // Cleared again: closed again for new requests (existing tickets are untouched).
    expect((await h.req("/api/party/details", api(os, { support_phone: null }))).status).toBe(200);
    expect((await signup(h, party)).body.error).toBe("registration_not_open");
    expect((await viewTicket(h, s.body.link!)).status).toBe(200);
  });
});
