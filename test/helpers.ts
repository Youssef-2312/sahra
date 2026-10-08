import { env } from "cloudflare:test";
import { createApp, type Deps } from "../src/app";
import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL, JwksCache } from "../src/auth/google";
import { b64url, csrfFor, newId, newToken, parseToken, sha256, sha256hex } from "../src/lib/crypto";
import type { Intent, Ledger, LogEntry } from "../src/ledger";
import { TURNSTILE_VERIFY_URL } from "../src/guests/turnstile";

export const ORIGIN = "https://sahra.test";
export const CLIENT_ID = "test-client.apps.googleusercontent.com";

// ------------------------------------------------------------------ clock

export class Clock {
  constructor(public t = Date.UTC(2026, 9, 1, 18, 0, 0)) {}
  now = () => this.t;
  advance(ms: number) {
    this.t += ms;
  }
}

// ------------------------------------------------------------ fake Google

interface Key {
  kid: string;
  priv: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

async function newKey(kid: string): Promise<Key> {
  const kp = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey("jwk", kp.publicKey)) as JsonWebKey;
  return { kid, priv: kp.privateKey, jwk: { kty: "RSA", n: pub.n, e: pub.e, alg: "RS256", use: "sig", kid } };
}

export interface Identity {
  sub: string;
  email: string;
  email_verified?: boolean;
  hd?: string;
  name?: string;
}

/**
 * Stands in for accounts.google.com: serves a JWKS and a token endpoint. The
 * token endpoint returns an ID token for whatever identity and nonce the test
 * set up, with optional claim overrides to produce bad tokens.
 */
export class FakeGoogle {
  keys: Key[] = [];
  published: Key[] = [];
  jwksFetches = 0;
  identity: Identity = { sub: "1001", email: "owner@gmail.com", email_verified: true };
  override: Record<string, unknown> = {};
  signWith: Key | null = null;
  headerKid: string | null = null;
  nonceFor: string | null = null;
  tamper = false;
  tokenRequests: URLSearchParams[] = [];
  /** code -> PKCE challenge, registered when the browser "returns" from Google. */
  codes = new Map<string, string>();
  usedCodes = new Set<string>();

  static async create() {
    const g = new FakeGoogle();
    const k = await newKey("key-1");
    g.keys.push(k);
    g.published = [k];
    return g;
  }

  async rotate(kid: string, publish = true) {
    const k = await newKey(kid);
    this.keys.push(k);
    if (publish) this.published = [k, ...this.published];
    return k;
  }

  async idToken(nonce: string, now: number): Promise<string> {
    const key = this.signWith ?? this.published[0]!;
    const header = { alg: "RS256", kid: this.headerKid ?? key.kid, typ: "JWT" };
    const iat = Math.floor(now / 1000);
    const claims: Record<string, unknown> = {
      iss: "https://accounts.google.com",
      aud: CLIENT_ID,
      azp: CLIENT_ID,
      iat,
      exp: iat + 3600,
      nonce,
      ...this.identity,
      email_verified: this.identity.email_verified ?? true,
      ...this.override,
    };
    const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
    const signingInput = `${enc(header)}.${enc(claims)}`;
    const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.priv, new TextEncoder().encode(signingInput)));
    let tok = `${signingInput}.${b64url(sig)}`;
    if (this.tamper) {
      const forged = { ...claims, sub: "attacker" };
      tok = `${enc(header)}.${enc(forged)}.${b64url(sig)}`;
    }
    return tok;
  }

  fetcher(clock: Clock) {
    return async (input: string, init?: RequestInit): Promise<Response> => {
      if (input === GOOGLE_JWKS_URL) {
        this.jwksFetches++;
        return new Response(JSON.stringify({ keys: this.published.map((k) => k.jwk) }), {
          headers: { "content-type": "application/json", "cache-control": "public, max-age=20000" },
        });
      }
      if (input === GOOGLE_TOKEN_URL) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        this.tokenRequests.push(form);
        const code = form.get("code") ?? "";
        const challenge = this.codes.get(code);
        // Like Google: each code works once, and only with the matching PKCE verifier.
        if (!challenge || this.usedCodes.has(code)) return Response.json({ error: "invalid_grant" }, { status: 400 });
        this.usedCodes.add(code);
        if (b64url(await sha256(form.get("code_verifier") ?? "")) !== challenge) return Response.json({ error: "invalid_grant" }, { status: 400 });
        if (!this.nonceFor) return new Response("no", { status: 400 });
        return Response.json({ id_token: await this.idToken(this.nonceFor, clock.now()) });
      }
      return new Response("unexpected fetch " + input, { status: 599 });
    };
  }
}

// ------------------------------------------------------------- test client

/** Ledger wrapper that can fail or lose acknowledgements on demand. */
export class FlakyLedger implements Ledger {
  /** Change-log writes (putEntries). */
  mode: "ok" | "fail" | "lose_ack" = "ok";
  /** Admission record writes (recordAdmission). */
  admissionMode: "ok" | "fail" | "lose_ack" = "ok";
  /** Control object reads. */
  controlMode: "ok" | "fail" = "ok";
  /** Intent writes (putIntents). */
  intentMode: "ok" | "fail" = "ok";
  /** Runs inside recordAdmission AFTER the record is committed (e.g. to pause the party). */
  afterAdmissionWrite: null | (() => Promise<void>) = null;
  writes = 0;
  admissions = 0;
  constructor(public inner: Ledger) {}
  async putEntries(entries: LogEntry[]) {
    if (this.mode === "fail") throw new Error("injected ledger failure");
    await this.inner.putEntries(entries);
    this.writes++;
    if (this.mode === "lose_ack") throw new Error("injected lost acknowledgement");
  }
  async putIntents(intents: Intent[]) {
    if (this.intentMode === "fail") throw new Error("injected intent write failure");
    await this.inner.putIntents(intents);
  }
  async getControl(partyId: string) {
    if (this.controlMode === "fail") throw new Error("injected control read failure");
    return this.inner.getControl(partyId);
  }
  setControl(...args: Parameters<Ledger["setControl"]>) {
    return this.inner.setControl(...args);
  }
  async recordAdmission(entry: LogEntry) {
    if (this.admissionMode === "fail") throw new Error("injected admission write failure");
    if (this.afterAdmissionWrite) {
      // Split the real batch so something can happen between the write and the control re-read.
      await this.inner.putEntries([entry]);
      await this.afterAdmissionWrite();
      this.admissions++;
      return this.inner.getControl(entry.party_id);
    }
    const r = await this.inner.recordAdmission(entry);
    this.admissions++;
    if (this.admissionMode === "lose_ack") throw new Error("injected lost acknowledgement");
    return r;
  }
}

/**
 * Stands in for Turnstile's siteverify, answering like Cloudflare does for its
 * documented test secrets: 1x...AA always passes, 2x...AA always fails, 3x...AA
 * answers "token already spent"; any other secret is invalid. `down` simulates an
 * unreachable siteverify.
 */
export class FakeTurnstile {
  calls = 0;
  down = false;
  async fetch(init?: RequestInit): Promise<Response> {
    this.calls++;
    if (this.down) throw new Error("network down");
    const form = new URLSearchParams(String(init?.body ?? ""));
    const secret = form.get("secret") ?? "";
    const response = form.get("response") ?? "";
    const fail = (codes: string[]) => Response.json({ success: false, "error-codes": codes });
    if (!response) return fail(["missing-input-response"]);
    if (secret === "1x0000000000000000000000000000000AA") return Response.json({ success: true, hostname: "example.com", "error-codes": [] });
    if (secret === "2x0000000000000000000000000000000AA") return fail(["invalid-input-response"]);
    if (secret === "3x0000000000000000000000000000000AA") return fail(["timeout-or-duplicate"]);
    return fail(["invalid-input-secret"]);
  }
}

/** Cloudflare's documented dummy token (what the test site keys produce). */
export const TURNSTILE_TOKEN = "XXXX.DUMMY.TOKEN.XXXX";

export interface Harness {
  clock: Clock;
  google: FakeGoogle;
  turnstile: FakeTurnstile;
  ledger: FlakyLedger;
  jwks: JwksCache;
  app: ReturnType<typeof createApp>;
  req: (path: string, init?: RequestInit & { cookies?: Record<string, string> }) => Promise<Response>;
}

export async function harness(opts: { google?: FakeGoogle; clock?: Clock; env?: Partial<typeof env> } = {}): Promise<Harness> {
  const clock = opts.clock ?? new Clock();
  const google = opts.google ?? (await FakeGoogle.create());
  const ledger = new FlakyLedger(null as unknown as Ledger);
  const turnstile = new FakeTurnstile();
  const googleFetch = google.fetcher(clock);
  const fetcher = (input: string, init?: RequestInit) => input === TURNSTILE_VERIFY_URL ? turnstile.fetch(init) : googleFetch(input, init);
  const jwks = new JwksCache(fetcher);
  const deps: Deps = { fetch: fetcher, now: clock.now, jwks, ledger: (base) => { ledger.inner = base; return ledger; },
    driver: (base, which) => new OutageDriver(base, which) };
  const app = createApp(deps);
  const req = async (path: string, init: RequestInit & { cookies?: Record<string, string> } = {}) => {
    const headers = new Headers(init.headers);
    if (init.cookies) {
      headers.set("cookie", Object.entries(init.cookies).map(([k, v]) => `${k}=${v}`).join("; "));
    }
    return app.request(`${ORIGIN}${path}`, { ...init, headers }, opts.env ? { ...env, ...opts.env } : env);
  };
  return { clock, google, turnstile, ledger, jwks, app, req };
}

export function setCookies(res: Response): Record<string, { value: string; attrs: string }> {
  const out: Record<string, { value: string; attrs: string }> = {};
  for (const sc of res.headers.getSetCookie()) {
    const [nv, ...rest] = sc.split(";");
    const i = nv!.indexOf("=");
    out[nv!.slice(0, i).trim()] = { value: nv!.slice(i + 1), attrs: rest.join(";").trim() };
  }
  return out;
}

// --------------------------------------------------------------- seed data

export async function seedParty(id = `p${newId().slice(0, 8)}`): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO parties (id, name, capacity, created_at, logged_rev) VALUES (?, ?, 300, ?, 1)",
  ).bind(id, `Party ${id}`, Date.now()).run();
  return id;
}

/** Owner already linked to a Google account (as the bootstrap script leaves them after first sign-in). */
export async function seedOwner(partyId: string, sub = `sub-${newId()}`, role: "owner" | "admin" = "owner") {
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO staff (id, party_id, name, role, google_sub, invited_email, created_at, logged_rev) VALUES (?, ?, ?, ?, ?, ?, ?, 1)",
  ).bind(id, partyId, `Staff ${id.slice(0, 4)}`, role, sub, `${sub}@gmail.com`, Date.now()).run();
  return { id, sub };
}

/** Creates a session row directly and returns cookie + CSRF for API calls. */
export async function seedSession(partyId: string, staffId: string, role: "owner" | "admin" | "door", clock: Clock, ttlMs = 3600_000) {
  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO sessions (id_hash, kind, party_id, staff_id, role, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).bind(await sha256hex(token), role === "door" ? "door" : "google", partyId, staffId, role, clock.now(), clock.now() + ttlMs).run();
  return { token, hash: await sha256hex(token), csrf: await csrfFor(parseToken(token)!) };
}

export function api(sess: { token: string; csrf: string }, body?: unknown, method = "POST"): RequestInit & { cookies: Record<string, string> } {
  return {
    method,
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json", "x-sahra-csrf": sess.csrf },
    body: body === undefined ? undefined : JSON.stringify(body),
    cookies: { "__Host-sahra_s": sess.token },
  };
}

/** Change-log event ids for one entity, from the ledger database, as "<party>/<entity>/<id>/<rev>". */
export async function listLog(prefix: string): Promise<string[]> {
  const [party, entity, id] = prefix.replace(/^log\//, "").split("/");
  const r = await env.LEDGER.prepare("SELECT rev FROM change_log WHERE party_id = ? AND entity = ? AND entity_id = ? ORDER BY rev")
    .bind(party, entity, id).all<{ rev: number }>();
  return r.results.map((x) => `log/${party}/${entity}/${id}/${String(x.rev).padStart(10, "0")}.json`);
}

export async function logEntry(entity: string, id: string, rev: number) {
  const r = await env.LEDGER.prepare("SELECT * FROM change_log WHERE event_id = ?").bind(`${entity}:${id}:${rev}`).first<Record<string, unknown>>();
  return r ? { ...r, state: JSON.parse(String(r.state)) } : null;
}

/** Runs a full Google sign-in through the app. Returns the final response and cookies. */
export async function googleLogin(h: Harness, mutateBeforeCallback?: (ctx: { state: string; nonce: string; attempt: string; code: string }) => void | Promise<void>) {
  const start = await h.req("/api/auth/google/start", { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } });
  if (start.status !== 303) throw new Error(`start failed ${start.status}`);
  const loc = new URL(start.headers.get("location")!);
  const state = loc.searchParams.get("state")!;
  const nonce = loc.searchParams.get("nonce")!;
  const attempt = setCookies(start)["__Host-sahra_login"]!.value;
  h.google.nonceFor = nonce;
  const code = `code-${newId()}`;
  h.google.codes.set(code, loc.searchParams.get("code_challenge")!);
  const ctx = { state, nonce, attempt, code };
  await mutateBeforeCallback?.(ctx);
  const res = await h.req(`/api/auth/google/callback?state=${encodeURIComponent(ctx.state)}&code=${encodeURIComponent(ctx.code)}`, {
    cookies: ctx.attempt ? { "__Host-sahra_login": ctx.attempt } : {},
  });
  return { res, start, ctx, cookies: setCookies(res), html: await res.clone().text() };
}

// ------------------------------------------------------------- outages

import type { SqlDriver } from "../src/db/driver";

/** Driver wrapper that throws like an unreachable D1 database when `down` is set. */
export class OutageDriver implements SqlDriver {
  static down = { main: false, ledger: false };
  constructor(private readonly inner: SqlDriver, private readonly which: "main" | "ledger") {}
  get usage() { return this.inner.usage; }
  private check() {
    if (OutageDriver.down[this.which]) throw new Error("D1_ERROR: Network connection lost.");
  }
  async all<T>(q: Parameters<SqlDriver["all"]>[0]) { this.check(); return this.inner.all<T>(q); }
  async batch(qs: Parameters<SqlDriver["batch"]>[0]) { this.check(); return this.inner.batch(qs); }
}

// ------------------------------------------------------------- scanning

/** A door staff member with a session (a "phone"). */
export async function seedDoor(partyId: string, clock: Clock) {
  const id = newId();
  await env.DB.prepare("INSERT INTO staff (id, party_id, name, role, created_at, logged_rev) VALUES (?, ?, ?, 'door', ?, 1)")
    .bind(id, partyId, `Door ${id.slice(0, 4)}`, clock.now()).run();
  return { id, ...(await seedSession(partyId, id, "door", clock)) };
}

/** Party with an owner session, admission opened through the API. */
export async function openParty(h: Harness) {
  const party = await seedParty();
  const owner = await seedOwner(party);
  const os = await seedSession(party, owner.id, "owner", h.clock);
  const r = await h.req("/api/admission", api(os, { action: "open" }));
  if (r.status !== 200) throw new Error(`open failed ${r.status} ${await r.text()}`);
  return { party, owner, os };
}

export async function testTickets(h: Harness, sess: { token: string; csrf: string }, count = 1, people = 1) {
  const r = await h.req("/api/test/tickets", api(sess, { count, people }));
  if (r.status !== 200) throw new Error(`tickets failed ${r.status} ${await r.text()}`);
  return ((await r.json()) as { tickets: { id: string; qr: string }[] }).tickets;
}

export type Verdict = { verdict: string; reason?: string; name?: string; people?: number; when?: number; by?: string };

export async function scan(h: Harness, sess: { token: string; csrf: string }, qr: string, scanId = newId()): Promise<Verdict> {
  const r = await h.req("/api/scan", api(sess, { scan_id: scanId, qr }));
  if (r.status !== 200) return { verdict: `http_${r.status}` };
  return (await r.json()) as Verdict;
}

// ------------------------------------------------------------- guests

/** Smallest byte strings the image check accepts (signatures only; nothing decodes them). */
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46]);

export interface SignupFields {
  signup?: string;
  name?: string;
  email?: string;
  people?: number | string;
  answers?: unknown;
  screenshot?: Uint8Array | null;
  turnstile?: string | null;
}

/** A guest sign-up request as the page sends it: multipart with a Content-Length. */
export async function signupInit(f: SignupFields = {}): Promise<RequestInit> {
  const fd = new FormData();
  fd.set("signup", f.signup ?? newToken());
  fd.set("name", f.name ?? "Guest Name");
  fd.set("email", f.email ?? `guest-${newId().slice(0, 8)}@example.com`);
  fd.set("people", String(f.people ?? 1));
  if (f.answers !== undefined) fd.set("answers", JSON.stringify(f.answers));
  const shot = f.screenshot === undefined ? PNG : f.screenshot;
  if (shot) fd.set("screenshot", new File([shot], "shot.png", { type: "image/png" }));
  if (f.turnstile !== null) fd.set("cf-turnstile-response", f.turnstile ?? TURNSTILE_TOKEN);
  const r = new Request("https://x.invalid/", { method: "POST", body: fd });
  const body = new Uint8Array(await r.arrayBuffer());
  return {
    method: "POST",
    body,
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": r.headers.get("content-type")!, "content-length": String(body.length) },
  };
}

export async function signup(h: Harness, party: string, f: SignupFields = {}) {
  const res = await h.req(`/api/guest/parties/${party}/signup`, await signupInit(f));
  return { res, status: res.status, body: (await res.clone().json()) as { status?: string; ticket_id?: string; link?: string; error?: string } };
}

/** Party with chosen capacity and people per ticket, plus an owner session. */
export async function guestParty(h: Harness, a: { capacity?: number; maxPeople?: number; form?: unknown } = {}) {
  const party = `g${newId().slice(0, 8)}`;
  await env.DB.prepare("INSERT INTO parties (id, name, capacity, max_people_per_ticket, created_at, logged_rev, guest_form) VALUES (?, ?, ?, ?, ?, 1, ?)")
    .bind(party, `Party ${party}`, a.capacity ?? 300, a.maxPeople ?? 4, Date.now(), a.form === undefined ? null : JSON.stringify(a.form)).run();
  const owner = await seedOwner(party);
  const os = await seedSession(party, owner.id, "owner", h.clock);
  return { party, owner, os };
}

export async function viewTicket(h: Harness, link: string) {
  const token = link.replace(/^.*#t=/, "");
  const r = await h.req("/api/guest/ticket", { headers: { "x-sahra-ticket": token } });
  return { status: r.status, body: (await r.json()) as { ticket?: { status: string; qr: string | null; reject_reason: string | null; on_hold: boolean; guest_name: string }; party?: unknown; error?: string } };
}

// ------------------------------------------------------------- platform

/** Full platform (admin/organiser) Google sign-in through the app. */
export async function platformLogin(h: Harness, mutateBeforeCallback?: (ctx: { state: string; nonce: string; attempt: string; code: string }) => void | Promise<void>) {
  const start = await h.req("/api/auth/platform/start", { method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" } });
  if (start.status !== 303) throw new Error(`platform start failed ${start.status}`);
  const loc = new URL(start.headers.get("location")!);
  const state = loc.searchParams.get("state")!;
  const nonce = loc.searchParams.get("nonce")!;
  const attempt = setCookies(start)["__Host-sahra_login"]!.value;
  h.google.nonceFor = nonce;
  const code = `code-${newId()}`;
  h.google.codes.set(code, loc.searchParams.get("code_challenge")!);
  const ctx = { state, nonce, attempt, code };
  await mutateBeforeCallback?.(ctx);
  const res = await h.req(`/api/auth/google/callback?state=${encodeURIComponent(ctx.state)}&code=${encodeURIComponent(ctx.code)}`, {
    cookies: ctx.attempt ? { "__Host-sahra_login": ctx.attempt } : {},
  });
  return { res, cookies: setCookies(res), html: await res.clone().text() };
}

/** A linked, active site owner. */
export async function seedSiteOwner(sub = `pa-${newId()}`) {
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO platform_admins (id, name, email, google_sub, invite_expires_at, created_at, logged_rev) VALUES (?, ?, ?, ?, 0, 0, 1)",
  ).bind(id, `Admin ${id.slice(0, 4)}`, `${sub}@gmail.com`, sub).run();
  return { id, sub };
}

/** A linked, active organiser. */
export async function seedOrganiser(sub = `org-${newId()}`) {
  const id = newId();
  await env.DB.prepare(
    "INSERT INTO organisers (id, name, email, google_sub, created_at, logged_rev) VALUES (?, ?, ?, ?, 0, 1)",
  ).bind(id, `Organiser ${id.slice(0, 4)}`, `${sub}@gmail.com`, sub).run();
  return { id, sub };
}

/** A platform session row for a Google account; cookie + CSRF for API calls. */
export async function seedPlatformSession(sub: string, clock: Clock, ttlMs = 3600_000) {
  const token = newToken();
  await env.DB.prepare("INSERT INTO platform_sessions (id_hash, google_sub, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256hex(token), sub, clock.now(), clock.now() + ttlMs).run();
  return { token, hash: await sha256hex(token), csrf: await csrfFor(parseToken(token)!) };
}

/** Like `api`, with the platform session cookie. */
export function papi(sess: { token: string; csrf: string }, body?: unknown, method = "POST"): RequestInit & { cookies: Record<string, string> } {
  const r = api(sess, body, method);
  return { ...r, cookies: { "__Host-sahra_p": sess.token } };
}

// ------------------------------------------------------------- backup

/** A GET signed with BACKUP_KEY, as the owner's Apps Script sends it (src/backup/auth.ts). */
export async function backupGet(h: Harness, path: string, o: { key?: string; at?: number; headers?: Record<string, string> } = {}) {
  const { signedHeaders } = await import("../src/backup/auth");
  const headers = { ...(await signedHeaders(o.key ?? env.BACKUP_KEY!, "GET", `${ORIGIN}${path}`, o.at ?? h.clock.now())), ...o.headers };
  return h.req(path, { headers });
}

/** A POST signed with BACKUP_KEY (the signature covers the body). */
export async function backupPost(h: Harness, path: string, body: unknown, o: { key?: string; at?: number; contentType?: string } = {}) {
  const { signedHeaders } = await import("../src/backup/auth");
  const text = JSON.stringify(body);
  const headers = { ...(await signedHeaders(o.key ?? env.BACKUP_KEY!, "POST", `${ORIGIN}${path}`, o.at ?? h.clock.now(), text)), "content-type": o.contentType ?? "application/json" };
  return h.req(path, { method: "POST", body: text, headers });
}

type BackupRow = Record<string, unknown>;

/**
 * Walks the whole export like the Apps Script: manifest, every table page by
 * page (ledger last), then every screenshot, checking each file's SHA-256 and
 * size header against the bytes received. Returns an in-memory backup.
 */
export async function exportAll(h: Harness, limit = 200, o: { kind?: "nightly" | "hourly"; files?: boolean } = {}) {
  const { sha256hexBytes } = await import("../src/backup/restore");
  const m = await backupGet(h, o.kind === "hourly" ? "/api/backup/manifest?kind=hourly" : "/api/backup/manifest?counts=1");
  if (m.status !== 200) throw new Error(`manifest ${m.status}`);
  const manifest = (await m.json()) as { order: { db: string; table: string }[]; databases: Record<string, unknown> };
  const tables = new Map<string, BackupRow[]>();
  let requests = 1;
  for (const t of manifest.order) {
    const rows: BackupRow[] = [];
    let after: string | null = null;
    for (;;) {
      const r = await backupGet(h, `/api/backup/rows/${t.db}/${t.table}?limit=${limit}${after ? `&after=${after}` : ""}`);
      requests++;
      if (r.status !== 200) throw new Error(`${t.db}.${t.table} ${r.status} ${await r.text()}`);
      const page = (await r.json()) as { rows: BackupRow[]; next: string | null };
      rows.push(...page.rows);
      if (!page.next) break;
      after = page.next;
    }
    tables.set(`${t.db}.${t.table}`, rows);
  }
  // Every files database's list; a purged screenshot is not downloaded (the Worker answers 410).
  const files = new Map<string, { bytes: Uint8Array; sha256: string }>();
  let purged = 0;
  for (const t of manifest.order.filter((x) => x.table === "files")) {
    for (const f of o.files === false ? [] : tables.get(`${t.db}.files`) ?? []) {
      const r = await backupGet(h, `/api/backup/file/${t.db}/${f.id}`);
      requests++;
      if (f.purged_at != null) {
        if (r.status !== 410) throw new Error(`file ${t.db}:${f.id}: purged but answered ${r.status}`);
        purged++;
        continue;
      }
      const bytes = new Uint8Array(await r.arrayBuffer());
      const sha256 = await sha256hexBytes(bytes);
      if (r.status !== 200 || sha256 !== r.headers.get("x-sahra-sha256") || bytes.length !== Number(r.headers.get("x-sahra-size")) || bytes.length !== f.size) {
        throw new Error(`file ${t.db}:${f.id}: transfer check failed`);
      }
      files.set(`${t.db}:${f.id}`, { bytes, sha256 });
    }
  }
  return {
    manifest, tables, files, purged, requests,
    source: {
      rows: async (db: string, table: string) => tables.get(`${db}.${table}`) ?? [],
      file: async (db: string, id: number) => files.get(`${db}:${id}`) ?? null,
    },
  };
}
