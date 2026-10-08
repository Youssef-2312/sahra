// Per-party limits (workstream F), so one party cannot use up the account-wide
// free allowances that every party shares (DECISIONS "Operating model after
// handover"). This reduces the risk; it is not a guarantee.
//
// Only the expensive actions are counted (one row written per counted request,
// never on the scan path or the door join): guest sign-up, "resend my link",
// release ("Send QR", per ticket), guest notices, outbox approval and export
// pages. Each counter is one UPSERT whose WHERE clause holds the cap, so two
// requests at once never both pass it (D1 runs statements one at a time). The
// counter is written BEFORE the action's own batch: a request that is refused
// later (party full, nothing to release) still counts, which errs on the safe
// side.
//
// Non-essential work (notices, outbox approval = bulk email, exports) also stops
// while the app's own estimate of today's account-wide rows written
// (health_state.usage_est, kept by the health cron, src/health/) is at or above
// half the daily allowance. Essential actions (sign-up, resend link, release)
// keep only their per-party cap. The door is never limited here.

import type { Ctx } from "../context";
import { json } from "../context";
import type { SqlDriver } from "../db/driver";
import { sessionValid, type Role } from "../db";
import { sql, type Sql } from "../db/sql";

export type LimitKind = "signup" | "resend_link" | "release" | "notice" | "outbox_approve" | "export" | "reject_stale" | "issue" | "announce";

export const DAY_MS = 86_400_000;

/** Workers Free: 100,000 rows written per day for the whole account. */
export const ACCOUNT_DAILY_WRITES = 100_000;
/** Non-essential work stops at about half of it (DECISIONS "Quotas"). */
export const BUDGET_STOP_AT = ACCOUNT_DAILY_WRITES / 2;

/**
 * Per party per UTC day. Rows written per unit (measured, see DECISIONS
 * "Workstream F") times the cap keeps one party at or below roughly a tenth of
 * the account's daily writes for each kind.
 */
export const LIMITS: Record<LimitKind, { cap: number; essential: boolean; label: string }> = {
  // 8 rows written each (ticket, status index, email index, audit, logged_rev, counter, ledger, file; measured);
  // 9 with a ticket type (its index).
  signup: { cap: 1000, essential: true, label: "guest sign-ups" },
  // At most one email per address per 10 minutes anyway; 3 rows per email.
  resend_link: { cap: 300, essential: true, label: "ticket link requests" },
  // Per ticket released: about 8 rows (ticket, audit, logged_rev, ledger, outbox + 2 index entries; measured).
  release: { cap: 1000, essential: true, label: "tickets sent" },
  // One notice queues up to 1,000 emails (3 rows each).
  notice: { cap: 3, essential: false, label: "guest notices" },
  // One approval can queue many rows (2 rows each).
  outbox_approve: { cap: 50, essential: false, label: "email approvals" },
  // Reads up to 500 tickets per page, writes nothing besides this counter.
  export: { cap: 200, essential: false, label: "export pages" },
  // "Reject old pending requests": up to 20 tickets per call, about 5 rows each (ticket, index, audit, logged_rev, ledger).
  reject_stale: { cap: 100, essential: false, label: "bulk rejections of old requests" },
  // Staff-issued tickets (complimentary / door list), one per call: about 9 rows (ticket + 3 index entries, audit,
  // logged_rev, ledger, counter, and the email when sent at once). Essential: used at the door.
  issue: { cap: 500, essential: true, label: "tickets issued by staff" },
  // One announcement queues up to 1,000 emails awaiting approval (3 rows each), like a guest notice.
  announce: { cap: 3, essential: false, label: "announcements" },
};

export const dayOf = (now: number) => Math.floor(now / DAY_MS);

/** True while the app's estimate of today's rows written is under the stop line. */
export function budgetOk(now: number): Sql {
  return sql`NOT EXISTS (SELECT 1 FROM health_state WHERE id = 'main' AND usage_day = ${dayOf(now)} AND usage_est >= ${BUDGET_STOP_AT})`;
}

export type ChargeResult = "ok" | "party_limit" | "daily_budget";

/**
 * Counts `cost` units of `kind` for the party today, only if that stays within
 * the cap (and, for non-essential kinds, the account budget), and only if
 * `guard` holds (e.g. the session check). One statement; on refusal a second
 * read says why.
 */
export async function charge(driver: SqlDriver, partyId: string, kind: LimitKind, cost: number, now: number, guard: Sql = sql`1`): Promise<ChargeResult> {
  const l = LIMITS[kind];
  const day = dayOf(now);
  const budget = l.essential ? sql`1` : budgetOk(now);
  const r = await driver.all(sql`INSERT INTO party_usage (party_id, kind, day, n)
      SELECT ${partyId}, ${kind}, ${day}, ${cost} WHERE ${cost} <= ${l.cap} AND ${budget} AND ${guard}
    ON CONFLICT (party_id, kind, day) DO UPDATE SET n = n + excluded.n WHERE n + excluded.n <= ${l.cap}`);
  if (r.meta.changes === 1) return "ok";
  if (!l.essential) {
    const b = await driver.all<{ ok: number }>(sql`SELECT ${budgetOk(now)} AS ok`);
    if (!Number(b.results[0]?.ok)) return "daily_budget";
  }
  return "party_limit";
}

/**
 * The 429 answer for a refused charge. The words are for organisers and guests:
 * a safety pause, with no detail about the hosting plan (owner decision).
 */
export function limited(c: Ctx, kind: LimitKind, why: Exclude<ChargeResult, "ok">) {
  const l = LIMITS[kind];
  const label = l.label.charAt(0).toUpperCase() + l.label.slice(1);
  return json(c, 429, why === "daily_budget"
    ? { error: "daily_budget", message: `${label} are paused for the rest of the day and come back automatically overnight. Ticket scanning is not affected.` }
    : { error: "party_limit", message: `This party has reached today's maximum of ${l.cap} ${l.label}. It resets automatically overnight.`, limit: l.cap });
}

/** Every party's counters today (for the site owner page; party_usage is small: at most 8 days of rows). */
export async function partyUsageToday(driver: SqlDriver, now: number) {
  const r = await driver.all<{ party_id: string; kind: string; n: number }>(
    sql`SELECT party_id, kind, n FROM party_usage WHERE day = ${dayOf(now)}`);
  return r.results;
}

/**
 * For a party staff route (after requireAuth): counts `cost` units for the
 * session's party, with the session check inside the statement. Returns the 429
 * answer when refused, null when the request may go on.
 */
export async function chargeStaff(c: Ctx, kind: LimitKind, cost: number, roles: readonly Role[] = ["owner", "admin"]) {
  const a = c.var.auth;
  const now = c.var.deps.now();
  const r = await charge(c.var.db.driver, a.info.party_id, kind, cost, now, sessionValid({ hash: a.hash, partyId: a.info.party_id }, roles, now));
  return r === "ok" ? null : limited(c, kind, r);
}

/** For a guest route (after Turnstile): counts one unit for the party; only an existing party is counted. */
export async function chargeGuest(c: Ctx, partyId: string, kind: LimitKind) {
  const r = await charge(c.var.db.driver, partyId, kind, 1, c.var.deps.now(), sql`EXISTS (SELECT 1 FROM parties WHERE id = ${partyId})`);
  return r === "ok" ? null : limited(c, kind, r);
}
