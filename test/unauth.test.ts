// Every endpoint reachable without a session, with missing, junk or forged
// credentials, must write ZERO rows to either database. The only planned
// exceptions are door join WITH a valid invitation (covered in invites.test.ts),
// guest sign-up and "resend my ticket link" (Turnstile-protected, covered in
// guests.test.ts); here they are sent with a failing or missing Turnstile check.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { newId, newToken } from "../src/lib/crypto";
import { googleLogin, harness, ORIGIN, seedParty, signupInit, type Harness } from "./helpers";

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

const tid = "0123456789ABCDEF";
// A party guests can sign up for (default form: screenshot required).
const GP = "unauth-guests";
beforeAll(async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO parties (id, name, capacity, created_at, logged_rev) VALUES (?, 'Guests', 300, 0, 1)").bind(GP).run();
});
const failingBot = { TURNSTILE_SECRET: "2x0000000000000000000000000000000AA" };
const withEnv = async (e: Record<string, unknown>, f: (h: Harness) => Promise<Response>) => f(await harness({ env: e as never }));
const signupPath = `/api/guest/parties/${GP}/signup`;
const resendPath = `/api/guest/parties/${GP}/resend`;

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
  ["guest form", "GET", "/api/guest/parties/:party", (h) => h.req(`/api/guest/parties/${GP}`)],
  ["guest sign-up, Turnstile fails", "POST", "/api/guest/parties/:party/signup", () => withEnv(failingBot, async (h) => h.req(signupPath, await signupInit()))],
  ["guest sign-up, Turnstile token already spent", "POST", "/api/guest/parties/:party/signup", () => withEnv({ TURNSTILE_SECRET: "3x0000000000000000000000000000000AA" }, async (h) => h.req(signupPath, await signupInit()))],
  ["guest sign-up, no Turnstile token", "POST", "/api/guest/parties/:party/signup", async (h) => h.req(signupPath, await signupInit({ turnstile: null }))],
  ["guest sign-up, Turnstile secret missing", "POST", "/api/guest/parties/:party/signup", () => withEnv({ TURNSTILE_SECRET: undefined }, async (h) => h.req(signupPath, await signupInit()))],
  ["guest sign-up, test secret in production", "POST", "/api/guest/parties/:party/signup", () => withEnv({ ENABLE_TEST_TICKETS: "0" }, async (h) => h.req(signupPath, await signupInit()))],
  ["guest sign-up, siteverify unreachable", "POST", "/api/guest/parties/:party/signup", async (h) => { h.turnstile.down = true; return h.req(signupPath, await signupInit()); }],
  ["guest sign-up, wrong origin", "POST", "/api/guest/parties/:party/signup", async (h) => { const i = await signupInit(); return h.req(signupPath, { ...i, headers: { ...(i.headers as Record<string, string>), origin: "https://evil.example" } }); }],
  ["resend link, Turnstile fails", "POST", "/api/guest/parties/:party/resend", () => withEnv(failingBot, (h) => h.req(resendPath, { method: "POST", headers: JSON_H, body: JSON.stringify({ email: "a@example.com", turnstile: "XXXX.DUMMY.TOKEN.XXXX" }) }))],
  ["resend link, no Turnstile token", "POST", "/api/guest/parties/:party/resend", (h) => h.req(resendPath, { method: "POST", headers: JSON_H, body: JSON.stringify({ email: "a@example.com" }) })],
  ["guest ticket page, forged link", "GET", "/api/guest/ticket", (h) => h.req("/api/guest/ticket", { headers: { "x-sahra-ticket": `T1.${GP.toUpperCase()}.1${tid}.1.${"A".repeat(26)}` } })],
  ["ticket list, junk session", "GET", "/api/tickets", (h) => h.req("/api/tickets", { cookies: junkCookie })],
  ["guest form get, junk session", "GET", "/api/tickets/form", (h) => h.req("/api/tickets/form", { cookies: junkCookie })],
  ["guest form set, junk session", "POST", "/api/tickets/form", (h) => h.req("/api/tickets/form", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ form: { questions: [] } }) })],
  ["export, junk session", "GET", "/api/tickets/export", (h) => h.req("/api/tickets/export", { cookies: junkCookie })],
  ["screenshot, junk session", "GET", "/api/tickets/:id/screenshot", (h) => h.req(`/api/tickets/${tid}/screenshot`, { cookies: junkCookie })],
  ["approve, junk session", "POST", "/api/tickets/approve", (h) => h.req("/api/tickets/approve", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ ids: [tid] }) })],
  ["reject, junk session", "POST", "/api/tickets/reject", (h) => h.req("/api/tickets/reject", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ ids: [tid] }) })],
  ["release, junk session", "POST", "/api/tickets/release", (h) => h.req("/api/tickets/release", { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ ids: [tid] }) })],
  ["cancel, junk session", "POST", "/api/tickets/:id/cancel", (h) => h.req(`/api/tickets/${tid}/cancel`, { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ op: newId() }) })],
  ["reissue, junk session", "POST", "/api/tickets/:id/reissue", (h) => h.req(`/api/tickets/${tid}/reissue`, { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ op: newId() }) })],
  ["transfer, junk session", "POST", "/api/tickets/:id/transfer", (h) => h.req(`/api/tickets/${tid}/transfer`, { method: "POST", headers: JSON_H, cookies: junkCookie, body: JSON.stringify({ op: newId(), name: "X" }) })],
  ["approve, no session", "POST", "/api/tickets/approve", (h) => h.req("/api/tickets/approve", { method: "POST", headers: JSON_H, body: JSON.stringify({ ids: [tid] }) })],
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
      await seedParty();
      const before = await counts();
      const res = await run(h);
      if (res.status === 200 && label !== "guest form") {
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
  const tables = ["parties", "staff", "invites", "sessions", "audit", "tickets", "scans", "outbox"];
  const out: Record<string, unknown> = {};
  for (const t of tables) out[t] = await env.DB.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(rev), 0) AS r FROM ${t}`).first().catch(async () => env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first());
  for (const t of ["change_log", "party_control", "intents"]) out[t] = await env.LEDGER.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first("n");
  out.files = await env.FILES!.prepare("SELECT COUNT(*) AS n FROM files").first("n");
  return out;
}
