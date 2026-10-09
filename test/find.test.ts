// "Find my tickets" (brainstorm idea 4): one email with the links to every live
// ticket of an address across parties; the same answer whether or not the
// address has tickets; at most one email per address per hour; ended, disabled
// and cancelled are left out; the email goes with the soonest party's details.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Driver } from "../src/db/driver";
import { eraseGuestDetails } from "../src/guests/retention";
import { clearPartyListCache } from "../src/routes/guests";
import { LIMITS } from "../src/limits";
import { api, guestParty, harness, ORIGIN, signup, viewTicket, type Harness } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;
const find = (h: Harness, email: string, headers: Record<string, string> = {}) => h.req("/api/guest/find", {
  method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", ...headers },
  body: JSON.stringify({ email, turnstile: "XXXX.DUMMY.TOKEN.XXXX" }),
});
const mails = async (to: string) => (await env.DB.prepare("SELECT party_id, kind, subject, body_text, status FROM outbox WHERE to_email = ? AND id LIKE 'find-%' ORDER BY created_at")
  .bind(to).all<{ party_id: string; kind: string; subject: string; body_text: string; status: string }>()).results;

describe("find my tickets", () => {
  it("one email with every live ticket across parties; the same answer for an unknown address", async () => {
    const h = await harness();
    const now = h.clock.now();
    const a = await guestParty(h), b = await guestParty(h), ended = await guestParty(h), off = await guestParty(h);
    await env.DB.prepare("UPDATE parties SET name = 'Rooftop', starts_at = ?, time_zone = 'Africa/Cairo' WHERE id = ?").bind(now + 2 * DAY, a.party).run();
    await env.DB.prepare("UPDATE parties SET name = 'Garden', starts_at = ? WHERE id = ?").bind(now + 9 * DAY, b.party).run();
    const email = `find${Date.now()}@example.com`;
    const t1 = await signup(h, a.party, { email });
    const t2 = await signup(h, b.party, { email });
    const t3 = await signup(h, b.party, { email });
    const gone = await signup(h, ended.party, { email });
    const disabled = await signup(h, off.party, { email });
    await h.req(`/api/tickets/${t3.body.ticket_id}/cancel`, api(b.os, { op: crypto.randomUUID() }));
    await env.DB.prepare("UPDATE parties SET starts_at = ?, ends_at = ? WHERE id = ?").bind(now - 3 * DAY, now - 2 * DAY, ended.party).run();
    await env.DB.prepare("UPDATE parties SET disabled_at = ? WHERE id = ?").bind(now, off.party).run();

    const unknown = await find(h, "nobody-here@example.com");
    const known = await find(h, `  ${email.toUpperCase()} `);
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(await unknown.json()).toEqual(await known.json());
    expect(await mails("nobody-here@example.com")).toHaveLength(0);

    const m = await mails(email);
    expect(m).toHaveLength(1);
    // Filed under the soonest party; sent without approval, like any ticket link email.
    expect(m[0]).toMatchObject({ party_id: a.party, kind: "ticket_link", subject: "Your Sahra tickets", status: "queued" });
    const body = m[0]!.body_text;
    expect(body).toContain(`${ORIGIN}${t1.body.link}`);
    expect(body).toContain(`${ORIGIN}${t2.body.link}`);
    for (const left of [t3, gone, disabled]) expect(body).not.toContain(left.body.link!);
    expect(body.indexOf("Rooftop")).toBeLessThan(body.indexOf("Garden"));
    expect(body).not.toMatch(/[—]|\p{Extended_Pictographic}/u);
    // Each link opens its own ticket.
    for (const x of [t1, t2]) expect((await viewTicket(h, x.body.link!)).status).toBe(200);
  });

  it("at most one email per address per hour; refuses a bad address, a failed check and another origin", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const email = `once${Date.now()}@example.com`;
    await signup(h, party, { email });
    await find(h, email);
    await find(h, email);
    expect(await mails(email)).toHaveLength(1);
    h.clock.advance(60 * 60_000);
    await find(h, email);
    expect(await mails(email)).toHaveLength(2);

    expect((await find(h, "not-an-email")).status).toBe(400);
    expect((await find(h, email, { origin: "https://evil.example" })).status).toBe(403);
    const noCheck = await h.req("/api/guest/find", { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ email, turnstile: "" }) });
    expect(noCheck.ok).toBe(false);
  });

  it("is counted site-wide per day, whether or not anything is sent; the page gets the site key", async () => {
    const h = await harness();
    const before = Number((await env.DB.prepare("SELECT n FROM party_usage WHERE party_id = '_platform' AND kind = 'find_tickets'").first("n")) ?? 0);
    await find(h, `count${Date.now()}@example.com`);
    const after = Number(await env.DB.prepare("SELECT n FROM party_usage WHERE party_id = '_platform' AND kind = 'find_tickets'").first("n"));
    expect(after).toBe(before + 1);
    const cap = LIMITS.find_tickets.cap;
    await env.DB.prepare("UPDATE party_usage SET n = ? WHERE party_id = '_platform' AND kind = 'find_tickets'").bind(cap).run();
    const r = await find(h, `over${Date.now()}@example.com`);
    expect(r.status).toBe(429);
    await env.DB.prepare("UPDATE party_usage SET n = 0 WHERE party_id = '_platform' AND kind = 'find_tickets'").run();
    const key = (await (await h.req("/api/guest/find")).json()) as { turnstile_site_key: string | null };
    expect("turnstile_site_key" in key).toBe(true);
  });

  it("the email is erased with the soonest party's guest details", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const now = h.clock.now();
    await env.DB.prepare("UPDATE parties SET starts_at = ? WHERE id = ?").bind(now + DAY, party).run();
    const email = `erase${Date.now()}@example.com`;
    await signup(h, party, { email });
    await find(h, email);
    expect(await mails(email)).toHaveLength(1);
    await env.DB.prepare("UPDATE parties SET starts_at = ?, ends_at = ? WHERE id = ?").bind(now - 9 * DAY, now - 8 * DAY, party).run();
    await eraseGuestDetails(new D1Driver(env.DB), new D1Driver(env.LEDGER), now);
    expect(await env.DB.prepare("SELECT to_email, body_text FROM outbox WHERE party_id = ? AND id LIKE 'find-%'").bind(party).first())
      .toEqual({ to_email: "", body_text: "" });
  });
});
