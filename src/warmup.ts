// Warm-up at Worker startup (CPU pass 2). The first scan or join in a fresh
// isolate measured 10-14 ms of CPU on staging, against a 10 ms limit per request;
// most of it is V8 compiling and first running our own code. Startup (the global
// scope) has its own, much larger limit, so this module runs the scan, join and
// session code paths once there, against an in-memory stand-in for the
// databases.
//
// Safety: nothing here can reach real data. The stand-in env has no real
// bindings and a fixed, public dummy secret; every cache keyed by a secret is
// keyed by its value, so real requests never see these entries. Everything is
// wrapped so a failure only means less warm-up, never a failed start. Workers
// forbid random values and body streams in the global scope: request bodies are
// supplied directly, and the paths that create random ids stop there (the
// database-layer functions they would call are warmed directly instead).

import { cookie } from "./lib/http";
import { flushChangeLog } from "./changelog";
import { D1Driver } from "./db/driver";
import { Db } from "./db";
import { TicketDb } from "./db/tickets";
import { D1Ledger } from "./ledger";
import { csrfFor, parseToken, sha256hex } from "./lib/crypto";
import { signQr } from "./qr";

const ORIGIN = "https://warmup.invalid";
const PARTY = "warmup";
// Base64url of 32 fixed bytes. Not a secret: it only ever signs warm-up codes.
const DUMMY_KEY = "d2FybXVwLW9ubHktbm90LWEtc2VjcmV0LTMyLWJ5dGVzLg";
const TOKEN = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TOKEN2 = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const SCAN_ID = "00000000-0000-4000-8000-000000000000";
const T = 1_700_000_000_000;

type Row = Record<string, unknown>;

/** Canned answers by statement text: enough for each code path to run to its end. */
function answer(text: string, h: { session: string }): Row[] {
  if (text.includes("FROM party_control")) return [{ state: "open", pause_number: 1, rev: 1 }];
  if (text.includes("LEFT JOIN scans sc")) {
    return [{ party_id: PARTY, session_hash: h.session, ticket_id: "0000000000000000", qr_version: 1, qr_fingerprint: "x",
      pause_number: 1, outcome: "admitted", ticket_rev: 2, created_at: T, session_ok: 1, session_party: PARTY }];
  }
  if (text.includes("FROM tickets t WHERE")) {
    return [{ id: "0000000000000000", party_id: PARTY, qr_version: 1, status: "approved", people: 1, guest_name: "w",
      used_scan_id: SCAN_ID, used_at: T, used_by: "s", released_at: T, rev: 2, logged_rev: 1, used_by_name: "w" }];
  }
  if (text.includes("FROM invites i LEFT JOIN sessions")) {
    return [{ id: "i", party_id: PARTY, staff_id: "s", used_at: T, revoked_at: null, expires_at: T + 1, session_hash: h.session,
      last_op: "o", s_hash: h.session, s_revoked_at: null, s_expires_at: T + 2, staff_disabled_at: null, staff_name: "w", under_cap: 1 }];
  }
  if (text.includes("FROM invites WHERE rev > logged_rev")) return [{ id: "i", party_id: PARTY, rev: 2, logged_rev: 1, last_action: "invite_used" }];
  if (text.includes("FROM sessions s JOIN staff a ON a.id = s.staff_id JOIN parties p")) {
    return [{ party_id: PARTY, party_name: "w", staff_id: "s", staff_name: "w", role: "door", kind: "door", expires_at: T + 1 }];
  }
  if (text.includes("FROM parties WHERE id =")) return [{ admission_state: "open", pause_number: 1, rev: 1 }];
  return [];
}

function fakeD1(h: { session: string }) {
  const result = (text: string) => ({ results: answer(text, h), success: true, meta: { changes: 1, rows_read: 1, rows_written: 1 } });
  const stmt = (text: string): unknown => ({
    text,
    bind: () => stmt(text),
    all: async () => result(text),
    run: async () => result(text),
  });
  return {
    prepare: (text: string) => stmt(text),
    batch: async (list: { text: string }[]) => list.map((s) => result(s.text)),
  } as unknown as D1Database;
}

interface FetchApp {
  fetch(req: Request, env: unknown, ctx: unknown): Response | Promise<Response>;
}

function post(path: string, body: unknown, token?: string, csrf?: string): Request {
  const headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" };
  if (token) headers.cookie = `__Host-sahra_s=${token}`;
  if (csrf) headers["x-sahra-csrf"] = csrf;
  const req = new Request(ORIGIN + path, { method: "POST", headers });
  // Reading a body stream is not allowed at startup; Hono reads JSON through text().
  const text = JSON.stringify(body);
  Object.defineProperty(req, "text", { value: async () => text });
  return req;
}

function get(path: string, token: string): Request {
  return new Request(ORIGIN + path, { headers: { cookie: `__Host-sahra_s=${token}` } });
}

export async function warmUp(app: FetchApp, done: () => void): Promise<void> {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const session = await sha256hex(TOKEN);
    const h = { session };
    const limiter = { limit: async () => ({ success: true }) };
    const env = {
      DB: fakeD1(h), LEDGER: fakeD1(h), RL_AUTH: limiter, RL_SCAN: limiter, PUBLIC_ORIGIN: ORIGIN,
      GOOGLE_CLIENT_ID: "warmup", ENABLE_TEST_TICKETS: "0", QR_KEY_ID: "1", COOKIE_KEY_ID: "1",
      QR_MASTER_K1: DUMMY_KEY, LINK_MASTER_K1: DUMMY_KEY, COOKIE_MASTER_K1: DUMMY_KEY,
    };
    const ctx = { waitUntil() {}, passThroughOnException() {} };
    const csrf = await csrfFor(parseToken(TOKEN)!);
    const qr = await signQr(env, { partyId: PARTY, ticketId: "0000000000000000", version: 1 });
    const run = async (req: Request) => {
      try {
        const res = await app.fetch(req, env, ctx);
        await res.text();
      } catch { /* less warm-up only */ }
    };
    // Twice each: the second run takes the paths a first run's caches skip.
    for (let i = 0; i < 2; i++) {
      await run(post("/api/scan", { scan_id: SCAN_ID, qr }, TOKEN, csrf));
      await run(post("/api/invites/consume", { token: TOKEN2, session: TOKEN }));
      await run(get("/api/me", TOKEN));
      await run(get("/api/admission", TOKEN));
    }
    // The parts of the scan and join paths that come after a random id.
    for (let i = 0; i < 2; i++) {
      try {
        const driver = new D1Driver(env.DB);
        const ledger = new D1Ledger(new D1Driver(env.LEDGER));
        const r = await new TicketDb(driver).redeem({
          scanId: SCAN_ID, partyId: PARTY, sessionHash: session, ticketId: "0000000000000000", qrVersion: 1,
          fingerprint: "x", pauseNumber: 1, now: T, op: SCAN_ID,
        });
        const t = r.ticket!;
        const { logged_rev: _ignored, ...state } = t;
        await ledger.recordAdmission({
          event_id: `ticket:${t.id}:${t.rev}`, party_id: t.party_id, entity: "ticket", entity_id: t.id, rev: t.rev,
          action: "admitted", logged_at: T, state: JSON.stringify(state),
        });
        const db = new Db(driver);
        await db.consumeDoorInvite({ tokenHash: session, sessionHash: session, now: T, expiresAt: T + 1, op: SCAN_ID });
        await flushChangeLog(db, ledger, T);
        cookie("__Host-sahra_s", TOKEN, { maxAgeS: 60, sameSite: "Strict" });
      } catch { /* less warm-up only */ }
    }
  } catch { /* less warm-up only */ } finally {
    console.log = log;
    console.error = error;
    done();
  }
}
