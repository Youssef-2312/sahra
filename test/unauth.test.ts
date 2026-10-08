// Every endpoint reachable without a session, with missing, junk or forged
// credentials, must write ZERO rows to either database. The only planned
// exceptions are door join WITH a valid invitation (covered in invites.test.ts) and
// guest sign-up (Phase 4, Turnstile-protected).
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, newToken } from "../src/lib/crypto";
import { googleLogin, harness, ORIGIN, seedParty, type Harness } from "./helpers";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
});
afterEach(() => vi.restoreAllMocks());

function lastReq() {
  const l = logs.filter((x) => x.startsWith('{"evt":"req"')).at(-1);
  return l ? (JSON.parse(l) as { route: string; method: string; status: number; rows_written: number; ledger_rows_written: number }) : null;
}

const JSON_H = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" };
const junkCookie = { "__Host-sahra_s": newToken() };
const id = newId();

// Read-only public pages that answer 200 without a session (still zero writes).
const PUBLIC_READS = new Set(["public party page, existing party"]);

type Case = [label: string, method: string, path: string, run: (h: Harness) => Promise<Response>];

const cases: Case[] = [
  ["sign-in start", "POST", "/api/auth/google/start", (h) => h.req("/api/auth/google/start", { method: "POST", headers: { origin: ORIGIN } })],
  ["sign-in start, wrong origin", "POST", "/api/auth/google/start", (h) => h.req("/api/auth/google/start", { method: "POST", headers: { origin: "https://evil.example" } })],
  ["callback, no cookie", "GET", "/api/auth/google/callback", (h) => h.req(`/api/auth/google/callback?state=${newToken()}&code=x`)],
  ["callback, forged cookie", "GET", "/api/auth/google/callback", (h) => h.req(`/api/auth/google/callback?state=${newToken()}&code=x`, { cookies: { "__Host-sahra_login": "1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAA" } })],
  ["callback, Google refuses the code", "GET", "/api/auth/google/callback", async (h) => (await googleLogin(h, (ctx) => { ctx.code = "never-issued"; })).res],
  ["callback, bad ID token", "GET", "/api/auth/google/callback", async (h) => { h.google.override = { aud: "other" }; const r = (await googleLogin(h)).res; h.google.override = {}; return r; }],
  ["callback, verified Google account that is not staff", "GET", "/api/auth/google/callback", async (h) => { h.google.identity = { sub: `stranger-${newId()}`, email: "stranger@gmail.com" }; return (await googleLogin(h)).res; }],
  ["select party, no cookie", "POST", "/api/auth/select-party", (h) => { const f = new FormData(); f.set("party_id", "x"); return h.req("/api/auth/select-party", { method: "POST", body: f, headers: { origin: ORIGIN } }); }],
  ["select party, forged cookie", "POST", "/api/auth/select-party", (h) => { const f = new FormData(); f.set("party_id", "x"); return h.req("/api/auth/select-party", { method: "POST", body: f, headers: { origin: ORIGIN }, cookies: { "__Host-sahra_pick": "1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAAAAAAAA" } }); }],
  ["logout, junk session", "POST", "/api/auth/logout", (h) => h.req("/api/auth/logout", { method: "POST", headers: JSON_H, cookies: junkCookie })],
  ["me, no session", "GET", "/api/me", (h) => h.req("/api/me")],
  ["me, junk session", "GET", "/api/me", (h) => h.req("/api/me", { cookies: junkCookie })],
  ["door join, unknown invitation", "POST", "/api/invites/consume", (h) => h.req("/api/invites/consume", { method: "POST", headers: JSON_H, body: JSON.stringify({ token: newToken(), session: newToken() }) })],
  ["door join, malformed", "POST", "/api/invites/consume", (h) => h.req("/api/invites/consume", { method: "POST", headers: JSON_H, body: "{" })],
  ["revoke invite, junk session", "POST", "/api/invites/:id/revoke", (h) => h.req(`/api/invites/${id}/revoke`, { method: "POST", headers: JSON_H, cookies: junkCookie })],
  ["staff list, junk session", "GET", "/api/staff", (h) => h.req("/api/staff", { cookies: junkCookie })],
  ["google invite, junk session", "POST", "/api/staff/google-invite", (h) => h.req("/api/staff/google-invite", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ staff_id: id, invite_id: newId(), name: "x", email: "x@gmail.com", role: "owner" }) })],
  ["door invite, junk session", "POST", "/api/staff/door-invite", (h) => h.req("/api/staff/door-invite", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ staff_id: id, invite_id: newId(), name: "x", token: newToken() }) })],
  ["role change, junk session", "POST", "/api/staff/:id/role", (h) => h.req(`/api/staff/${id}/role`, { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ role: "owner" }) })],
  ["disable, junk session", "POST", "/api/staff/:id/disable", (h) => h.req(`/api/staff/${id}/disable`, { method: "POST", headers: JSON_H, cookies: junkCookie })],
  ["scan, no session", "POST", "/api/scan", (h) => h.req("/api/scan", { method: "POST", headers: JSON_H, body: JSON.stringify({ scan_id: newId(), qr: "S1.X" }) })],
  ["scan, junk session", "POST", "/api/scan", (h) => h.req("/api/scan", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ scan_id: newId(), qr: "S1.X" }) })],
  ["admission state, junk session", "GET", "/api/admission", (h) => h.req("/api/admission", { cookies: junkCookie })],
  ["admission change, junk session", "POST", "/api/admission", (h) => h.req("/api/admission", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ action: "open" }) })],
  ["test tickets, junk session", "POST", "/api/test/tickets", (h) => h.req("/api/test/tickets", { method: "POST", headers: JSON_H, cookies: junkCookie, body: "{}" })],
  ["test door invite, junk session", "POST", "/api/test/door-invite", (h) => h.req("/api/test/door-invite", { method: "POST", headers: JSON_H, cookies: junkCookie, body: "{}" })],
  ["test revoke door access, junk session", "POST", "/api/test/revoke-door-access", (h) => h.req("/api/test/revoke-door-access", { method: "POST", headers: JSON_H, cookies: junkCookie, body: "{}" })],
  ["test ledger check, junk session", "GET", "/api/test/ledger-check", (h) => h.req("/api/test/ledger-check", { cookies: junkCookie })],
  ["recovery holds, junk session", "GET", "/api/recovery/holds", (h) => h.req("/api/recovery/holds", { cookies: junkCookie })],
  ["release ticket hold, junk session", "POST", "/api/recovery/tickets/:id/release-hold", (h) => h.req("/api/recovery/tickets/0000000000000000/release-hold", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ reason: "xyz" }) })],
  ["release staff hold, junk session", "POST", "/api/recovery/staff/:id/release-hold", (h) => h.req(`/api/recovery/staff/${id}/release-hold`, { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ reason: "xyz" }) })],
  ["party details, no session", "GET", "/api/party", (h) => h.req("/api/party")],
  ["party details, junk session", "GET", "/api/party", (h) => h.req("/api/party", { cookies: junkCookie })],
  ["party edit, no session", "POST", "/api/party/details", (h) => h.req("/api/party/details", { method: "POST", headers: JSON_H, body: JSON.stringify({ name: "x", capacity: 0 }) })],
  ["party edit, junk session", "POST", "/api/party/details", (h) => h.req("/api/party/details", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ address: "x", address_mode: "public" }) })],
  ["party reveal, junk session", "POST", "/api/party/reveal", (h) => h.req("/api/party/reveal", { method: "POST", headers: JSON_H, cookies: junkCookie, body: "{}" })],
  ["party preview, junk session", "GET", "/api/party/preview", (h) => h.req("/api/party/preview?viewer=public", { cookies: junkCookie })],
  ["public party page, unknown party", "GET", "/api/party/public/:id", (h) => h.req("/api/party/public/nope")],
  ["public party page, existing party", "GET", "/api/party/public/:id", async (h) => h.req(`/api/party/public/${await env.DB.prepare("SELECT id FROM parties LIMIT 1").first("id")}`)],
  ["outbox list, no session", "GET", "/api/outbox", (h) => h.req("/api/outbox")],
  ["outbox list, junk session", "GET", "/api/outbox", (h) => h.req("/api/outbox", { cookies: junkCookie })],
  ["outbox approve, no session", "POST", "/api/outbox/approve", (h) => h.req("/api/outbox/approve", { method: "POST", headers: JSON_H, body: JSON.stringify({ all_awaiting: true }) })],
  ["outbox approve, junk session", "POST", "/api/outbox/approve", (h) => h.req("/api/outbox/approve", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ all_awaiting: true }) })],
  ["outbox cancel, junk session", "POST", "/api/outbox/cancel", (h) => h.req("/api/outbox/cancel", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ all_awaiting: true }) })],
  ["outbox approve one, junk session", "POST", "/api/outbox/:id/approve", (h) => h.req(`/api/outbox/${id}/approve`, { method: "POST", headers: JSON_H, cookies: junkCookie })],
  ["outbox cancel one, junk session", "POST", "/api/outbox/:id/cancel", (h) => h.req(`/api/outbox/${id}/cancel`, { method: "POST", headers: JSON_H, cookies: junkCookie })],
  ["unknown API path", "GET", "/api/*", (h) => h.req("/api/nothing-here")],
];

describe("endpoints without a session write nothing", () => {
  it("covers every registered route", async () => {
    const h = await harness();
    const registered = new Set(h.app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));
    const covered = new Set(cases.map(([, m, p]) => `${m} ${p}`));
    for (const r of registered) expect(covered, `route without an unauthenticated case: ${r}`).toContain(r);
  });

  for (const [label, , , run] of cases) {
    it(label, async () => {
      const h = await harness();
      const p = await seedParty();
      // A row awaiting approval, so the outbox cases have something they must not change.
      await env.DB.prepare("INSERT INTO outbox (id, party_id, kind, to_email, subject, body_text, status, created_at) VALUES (?, ?, 'party_notice', 'g@example.com', 's', 'b', 'awaiting_approval', 1)")
        .bind(newId(), p).run();
      const before = await counts();
      const res = await run(h);
      if (res.status === 200 && !PUBLIC_READS.has(label)) {
        // The scanner protocol always answers 200 with a verdict; without a session it must be this one.
        expect(await res.clone().json(), label).toEqual({ verdict: "not_signed_in" });
      }
      const m = lastReq();
      expect(m, label).not.toBeNull();
      expect(m!.rows_written, label).toBe(0);
      expect(m!.ledger_rows_written, label).toBe(0);
      expect(await counts(), label).toEqual(before);
    });
  }
});

async function counts() {
  const tables = ["parties", "staff", "invites", "sessions", "audit", "tickets", "scans", "outbox", "email_quota"];
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(rev), 0) AS r FROM ${t}`).first().catch(async () => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first());
  out.outbox = await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox").first("n");
  out.outbox_status = await env.DB.prepare("SELECT status, COUNT(*) AS n FROM outbox GROUP BY status ORDER BY status").all().then((r) => r.results);
  for (const t of ["change_log", "party_control"]) out[t] = await env.LEDGER.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first("n");
  return out;
}
