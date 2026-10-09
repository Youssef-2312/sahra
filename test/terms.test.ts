// Terms acceptance on ticket requests (migrations/0017_terms_acceptance.sql,
// src/guests/policy.ts): the box is required by the server, the versions stored
// are the server's own, a form that showed older terms, rules or notice is
// refused before anything is stored, retries never add a second record, and
// tickets the guest did not request themselves keep an unknown acceptance.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuestDb } from "../src/guests/db";
import { D1Driver } from "../src/db/driver";
import { PRIVACY_VERSION, rulesVersion, TERMS_VERSION } from "../src/guests/policy";
import { newId, newToken } from "../src/lib/crypto";
import { clearPartyListCache } from "../src/routes/guests";
import privacyHtml from "../public/privacy.html?raw";
import termsHtml from "../public/terms.html?raw";
import { api, guestParty, harness, logEntry, signup, type Harness } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

type Policy = { terms_version: string; privacy_version: string; rules_version: string | null; email: boolean };
const ticketsOf = async (party: string) =>
  (await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n")) as number;
const row = async (id: string) =>
  (await env.DB.prepare("SELECT terms_version, rules_version, privacy_version, terms_accepted_at, created_at FROM tickets WHERE id = ?")
    .bind(id).first<{ terms_version: string | null; rules_version: string | null; privacy_version: string | null; terms_accepted_at: number | null; created_at: number }>())!;
async function formPolicy(h: Harness, party: string) {
  const r = await h.req(`/api/guest/parties/${party}`);
  return ((await r.json()) as { policy: Policy }).policy;
}

describe("terms acceptance", () => {
  it("the versions are the pages' own revision dates (change them together)", () => {
    const date = (html: string) => {
      const m = /Last updated: (\d{1,2}) (\w+) (\d{4})/.exec(html)!;
      const month = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"].indexOf(m[2]!) + 1;
      return `${m[3]}-${String(month).padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    };
    expect(date(termsHtml)).toBe(TERMS_VERSION);
    expect(date(privacyHtml)).toBe(PRIVACY_VERSION);
  });

  it("refuses a request without the box ticked, before anything is stored", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const r = await signup(h, party, { accept: false });
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("terms_not_accepted");
    expect((r.body as { message?: string }).message).toBe("Please accept the terms before submitting your request.");
    // Without the versions the form showed: refused too.
    expect((await signup(h, party, { terms: null })).status).toBe(400);
    expect((await signup(h, party, { privacy: null })).status).toBe(400);
    expect(await ticketsOf(party)).toBe(0);
    expect(h.turnstile.calls).toBe(0);
  });

  it("stores the server's versions and time with the request, in the change log too", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const p = await formPolicy(h, party);
    expect(p).toEqual({ terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, rules_version: null, email: false });
    const r = await signup(h, party);
    expect(r.status).toBe(201);
    const t = await row(r.body.ticket_id!);
    expect(t).toMatchObject({ terms_version: TERMS_VERSION, privacy_version: PRIVACY_VERSION, rules_version: null });
    expect(t.terms_accepted_at).toBe(t.created_at);
    expect(t.terms_accepted_at).toBe(h.clock.now());
    expect((await logEntry("ticket", r.body.ticket_id!, 1))!.state).toMatchObject({ terms_version: TERMS_VERSION, terms_accepted_at: t.created_at });
  });

  it("a party's entry rules are accepted by version; a form showing other rules is refused with the current ones", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    expect((await h.req("/api/party/details", api(os, { rules: "Over 21. No phones on the dance floor." }))).status).toBe(200);
    const p = await formPolicy(h, party);
    expect(p.rules_version).toBe(await rulesVersion("Over 21. No phones on the dance floor."));
    // The form that loaded before the rules existed.
    const stale = await signup(h, party, { rules: "" });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ error: "terms_changed", rules: "Over 21. No phones on the dance floor.", policy: p });
    expect(await ticketsOf(party)).toBe(0);
    const ok = await signup(h, party, { rules: p.rules_version });
    expect(ok.status).toBe(201);
    expect((await row(ok.body.ticket_id!)).rules_version).toBe(p.rules_version);

    // Rules edited after the form loaded: refused, then accepted with the new version.
    expect((await h.req("/api/party/details", api(os, { rules: "Over 18." }))).status).toBe(200);
    const again = await signup(h, party, { rules: p.rules_version });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: "terms_changed", rules: "Over 18." });
    const now = await formPolicy(h, party);
    expect(now.rules_version).not.toBe(p.rules_version);
    expect((await signup(h, party, { rules: now.rules_version })).status).toBe(201);
    // A made-up version is never stored: refused like any other mismatch.
    expect((await signup(h, party, { rules: "r-0000000000000000" })).status).toBe(409);
    expect(await ticketsOf(party)).toBe(2);
  });

  it("refuses older Terms or privacy notice versions; the notice version follows whether emails can be sent", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    expect((await signup(h, party, { terms: "2026-01-01" })).body.error).toBe("terms_changed");
    expect((await signup(h, party, { privacy: PRIVACY_VERSION + "+email" })).body.error).toBe("terms_changed");
    expect(await ticketsOf(party)).toBe(0);

    const he = await harness({ env: { GMAIL_ADDRESS: "platform@gmail.com", GMAIL_APP_PASSWORD: "test-only-app-password" } });
    const { party: p2 } = await guestParty(he);
    const pol = await formPolicy(he, p2);
    expect(pol).toMatchObject({ privacy_version: PRIVACY_VERSION + "+email", email: true });
    expect((await signup(he, p2)).body.error).toBe("terms_changed");
    const ok = await signup(he, p2, { privacy: pol.privacy_version });
    expect(ok.status).toBe(201);
    expect((await row(ok.body.ticket_id!)).privacy_version).toBe(PRIVACY_VERSION + "+email");
  });

  it("a retry is the same request and the same acceptance, even after the rules changed", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const token = newToken();
    const first = await signup(h, party, { signup: token });
    expect(first.status).toBe(201);
    const before = await row(first.body.ticket_id!);
    h.clock.advance(60_000);
    expect((await h.req("/api/party/details", api(os, { rules: "New rule" }))).status).toBe(200);
    const retry = await signup(h, party, { signup: token });
    expect(retry.status).toBe(200);
    expect(retry.body.ticket_id).toBe(first.body.ticket_id);
    expect(await row(first.body.ticket_id!)).toEqual(before);
    expect(await ticketsOf(party)).toBe(1);
    // A retry still needs the box: it is checked on every request.
    expect((await signup(h, party, { signup: token, accept: false })).status).toBe(400);
  });

  it("rules edited between the check and the insert refuse the request inside the statement", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    await env.DB.prepare("UPDATE parties SET rules = 'Rules now' WHERE id = ?").bind(party).run();
    const r = await new GuestDb(new D1Driver(env.DB)).signup({
      id: "ABCDEFGHJKMNPQRS", partyId: party, people: 1, name: "G", email: "g@example.com", answers: null, screenshotKey: null,
      typeId: null, now: h.clock.now(), op: newId(), rules: null, accepted: { terms: TERMS_VERSION, rules: null, privacy: PRIVACY_VERSION },
    });
    expect(r).toBe("terms_changed");
    expect(await ticketsOf(party)).toBe(0);
  });

  it("tickets issued by staff, and requests from before, keep an unknown acceptance", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const issued = await h.req("/api/tickets/issue", api(os, { op: newId(), name: "Door list guest" }));
    expect(issued.status).toBe(201);
    const id = ((await issued.json()) as { ticket_id: string }).ticket_id;
    expect(await row(id)).toMatchObject({ terms_version: null, rules_version: null, privacy_version: null, terms_accepted_at: null });
    // Only these four columns were added; nothing like an IP address is kept for acceptance.
    const cols = (await env.DB.prepare("SELECT name FROM pragma_table_info('tickets')").all<{ name: string }>()).results.map((c) => c.name);
    expect(cols.filter((c) => /terms|rules_version|privacy|ip/.test(c)).sort()).toEqual(["privacy_version", "rules_version", "terms_accepted_at", "terms_version"]);
  });
});
