import { env } from "cloudflare:test";
import { createApp, type Deps } from "../src/app";
import { GOOGLE_JWKS_URL, GOOGLE_TOKEN_URL, JwksCache } from "../src/auth/google";
import { b64url, csrfFor, newId, newToken, parseToken, sha256, sha256hex } from "../src/lib/crypto";
import type { Intent, Ledger, LogEntry } from "../src/ledger";

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

export interface Harness {
  clock: Clock;
  google: FakeGoogle;
  ledger: FlakyLedger;
  jwks: JwksCache;
  app: ReturnType<typeof createApp>;
  req: (path: string, init?: RequestInit & { cookies?: Record<string, string> }) => Promise<Response>;
}

export async function harness(opts: { google?: FakeGoogle; clock?: Clock; env?: Partial<typeof env> } = {}): Promise<Harness> {
  const clock = opts.clock ?? new Clock();
  const google = opts.google ?? (await FakeGoogle.create());
  const ledger = new FlakyLedger(null as unknown as Ledger);
  const fetcher = google.fetcher(clock);
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
  return { clock, google, ledger, jwks, app, req };
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
