// The outbox sender, run by the once-a-minute cron (src/index.ts `scheduled`).
//
// One run:
//   1. No provider configured: return without touching the database.
//   2. "Anything due?" (index outbox_due, at most 1 row read). Nothing: return.
//   3. Read the rolling 24-hour and per-minute counts (email_quota) and work out
//      how many emails this run may send (at most EMAIL.batch).
//   4. One batch: give up on rows stuck in "sending" with no attempts left, then
//      claim up to N due rows with ONE conditional UPDATE (queued, or sending past
//      its claim deadline -> sending, fresh claim_op, attempts + 1). Statements
//      run one at a time in D1, so two overlapping runs never claim the same row.
//   5. Send each claimed row: Gmail first, Brevo if Gmail definitely did not take
//      it. Write each result at once (one batch: the row, plus the provider's
//      hour counter when the attempt reached the provider), conditional on our
//      claim_op, so a run that lost its claim cannot overwrite another's result.
//
// A row whose result is unknown (connection lost after the end of DATA, a timeout,
// a provider server error) goes back to "queued" with exponential backoff and
// jitter: a retry may duplicate the email, which is acceptable (every email links
// to the same ticket page; over Gmail the Message-ID is the same) but kept rare.

import type { SqlDriver } from "../db/driver";
import { sql } from "../db/sql";
import type { Env } from "../env";
import { assertPlainText } from "../outbox";
import { BrevoProvider } from "./brevo";
import { isSafeAddress, type Message } from "./mime";
import type { Provider, ProviderName, SendResult } from "./provider";
import { SmtpProvider, type Connect } from "./smtp";

export const EMAIL = {
  /** Emails per run (a run is once a minute; Workers Free allows 10 ms CPU per invocation). */
  batch: 3,
  /** Rolling 24-hour caps, below the providers' own (Gmail about 500, Brevo free 300). */
  dayCap: { gmail: 450, brevo: 280 } as Record<ProviderName, number>,
  /** Per-minute caps (each run sends at most `batch`; these bound overlapping runs). */
  minuteCap: { gmail: 10, brevo: 10 } as Record<ProviderName, number>,
  /** A claimed row not finished by then is reclaimed by a later run. */
  claimTimeoutMs: 10 * 60_000,
  /** Attempts (claims) before a row is marked failed. */
  maxAttempts: 6,
  /** Backoff after attempt n: base * 2^(n-1), at most max, times a random 0.5 to 1.0. */
  backoffBaseMs: 2 * 60_000,
  backoffMaxMs: 2 * 3600_000,
  /** Stop starting new emails after this long (wall time) in one run. */
  runBudgetMs: 25_000,
  /** Per SMTP reply / per Brevo request. */
  timeoutMs: 15_000,
  fromName: "Sahra",
} as const;

export interface SenderDeps {
  now: () => number;
  random: () => number;
  connect: Connect;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface RunReport {
  skipped?: "no_provider" | "nothing_due" | "at_cap";
  claimed: number;
  sent: number;
  retry: number;
  failed: number;
  released: number;
  gaveUp: number;
}

/** Providers with complete settings, in the owner's order: the platform Gmail, then Brevo. */
export function configuredProviders(env: Env, deps: SenderDeps): Provider[] {
  const out: Provider[] = [];
  if (env.GMAIL_ADDRESS && env.GMAIL_APP_PASSWORD) {
    out.push(new SmtpProvider({
      connect: deps.connect, host: "smtp.gmail.com", port: 465,
      user: env.GMAIL_ADDRESS, pass: env.GMAIL_APP_PASSWORD.replace(/\s+/g, ""),
      fromEmail: env.GMAIL_ADDRESS, fromName: EMAIL.fromName,
      ehloName: hostOf(env.PUBLIC_ORIGIN), timeoutMs: EMAIL.timeoutMs,
    }));
  }
  if (env.BREVO_API_KEY && env.BREVO_SENDER) {
    out.push(new BrevoProvider({
      fetch: deps.fetch, apiKey: env.BREVO_API_KEY, sender: env.BREVO_SENDER, senderName: EMAIL.fromName, timeoutMs: EMAIL.timeoutMs,
    }));
  }
  return out;
}

function hostOf(origin: string): string {
  try { return new URL(origin).hostname || "localhost"; } catch { return "localhost"; }
}

export function backoffMs(attempts: number, random: number): number {
  const base = Math.min(EMAIL.backoffBaseMs * 2 ** Math.max(0, attempts - 1), EMAIL.backoffMaxMs);
  return Math.round(base * (0.5 + 0.5 * random));
}

interface Claimed {
  id: string;
  to_email: string;
  subject: string;
  body_text: string;
  attempts: number;
}

const HOUR = 3600_000;
const MINUTE = 60_000;

/** Remaining sends per provider now: rolling 24 hours and this minute. */
async function remaining(driver: SqlDriver, names: ProviderName[], now: number): Promise<Record<string, number>> {
  const hour = Math.floor(now / HOUR), minute = Math.floor(now / MINUTE);
  const r = await driver.all<{ provider: string; day: number; min: number }>(sql`SELECT provider, SUM(sent) AS day,
      COALESCE(MAX(CASE WHEN hour = ${hour} AND minute = ${minute} THEN minute_sent END), 0) AS min
    FROM email_quota WHERE provider IN ('gmail', 'brevo') AND hour > ${hour - 24} GROUP BY provider`);
  const out: Record<string, number> = {};
  for (const n of names) {
    const row = r.results.find((x) => x.provider === n);
    out[n] = Math.max(0, Math.min(EMAIL.dayCap[n] - Number(row?.day ?? 0), EMAIL.minuteCap[n] - Number(row?.min ?? 0)));
  }
  return out;
}

/** Counts one attempt that reached `provider` (or, with `exhaust`, fills its 24-hour cap). */
function countSend(provider: ProviderName, now: number, exhaust = false) {
  const hour = Math.floor(now / HOUR), minute = Math.floor(now / MINUTE);
  const add = exhaust ? EMAIL.dayCap[provider] : 1;
  return sql`INSERT INTO email_quota (provider, hour, sent, minute, minute_sent) VALUES (${provider}, ${hour}, ${add}, ${minute}, 1)
    ON CONFLICT (provider, hour) DO UPDATE SET sent = sent + excluded.sent,
      minute_sent = CASE WHEN minute = excluded.minute THEN minute_sent + 1 ELSE 1 END, minute = excluded.minute`;
}

export async function runSender(env: Env, driver: SqlDriver, deps: SenderDeps): Promise<RunReport> {
  const report: RunReport = { claimed: 0, sent: 0, retry: 0, failed: 0, released: 0, gaveUp: 0 };
  const providers = configuredProviders(env, deps);
  // Fail closed: without a provider nothing is claimed, so rows stay queued untouched.
  if (providers.length === 0) return { ...report, skipped: "no_provider" };
  const started = deps.now();

  const due = await driver.all(sql`SELECT 1 FROM outbox WHERE status IN ('queued', 'sending') AND next_attempt_at <= ${started} LIMIT 1`);
  if (due.results.length === 0) return { ...report, skipped: "nothing_due" };

  const left = await remaining(driver, providers.map((p) => p.name), started);
  const n = Math.min(EMAIL.batch, providers.reduce((s, p) => s + (left[p.name] ?? 0), 0));
  if (n === 0) return { ...report, skipped: "at_cap" };

  const op = crypto.randomUUID();
  const dueRow = sql`status IN ('queued', 'sending') AND next_attempt_at <= ${started}`;
  const rs = await driver.batch([
    sql`UPDATE outbox SET status = 'failed', last_error = 'result unknown after the last attempt (sender stopped)'
      WHERE status = 'sending' AND next_attempt_at <= ${started} AND attempts >= ${EMAIL.maxAttempts}`,
    sql`UPDATE outbox SET status = 'sending', claim_op = ${op}, attempts = attempts + 1, next_attempt_at = ${started + EMAIL.claimTimeoutMs}
      WHERE id IN (SELECT id FROM outbox WHERE ${dueRow} AND attempts < ${EMAIL.maxAttempts} ORDER BY next_attempt_at LIMIT ${n})
        AND ${dueRow} AND attempts < ${EMAIL.maxAttempts}
      RETURNING id, to_email, subject, body_text, attempts`,
  ]);
  report.gaveUp = rs[0]!.meta.changes;
  const rows = rs[1]!.results as unknown as Claimed[];
  report.claimed = rows.length;

  const mine = (id: string) => sql`id = ${id} AND claim_op = ${op} AND status = 'sending'`;
  try {
    for (const row of rows) {
      const now = deps.now();
      // Bad content is refused before any provider sees it.
      const bad = invalid(row);
      if (bad) {
        await driver.batch([sql`UPDATE outbox SET status = 'failed', last_error = ${bad} WHERE ${mine(row.id)}`]);
        report.failed++;
        continue;
      }
      const usable = providers.filter((p) => (left[p.name] ?? 0) > 0);
      if (usable.length === 0 || now - started > EMAIL.runBudgetMs) {
        // Not tried: back to the queue without using up an attempt.
        await driver.batch([sql`UPDATE outbox SET status = 'queued', attempts = attempts - 1, next_attempt_at = ${now} WHERE ${mine(row.id)}`]);
        report.released++;
        continue;
      }
      const msg: Message = {
        id: row.id, fromEmail: "", fromName: EMAIL.fromName, to: row.to_email, subject: row.subject, text: row.body_text,
      };
      let result: SendResult = { status: "not_sent", error: "no provider" };
      let used: ProviderName | null = null;
      const counts = [];
      for (const p of usable) {
        msg.fromEmail = p.name === "gmail" ? env.GMAIL_ADDRESS! : env.BREVO_SENDER!;
        result = await p.send(msg, now);
        used = p.name;
        if (result.status === "not_sent" && result.quotaExhausted) {
          counts.push(countSend(p.name, now, true));
          left[p.name] = 0;
        } else if (result.status !== "not_sent") {
          counts.push(countSend(p.name, now));
          left[p.name] = (left[p.name] ?? 0) - 1;
        }
        if (result.status === "not_sent" && result.providerDown) left[p.name] = 0;
        // Only a definite "not sent" may try the next provider at once.
        if (result.status !== "not_sent") break;
      }
      let update;
      if (result.status === "sent") {
        update = sql`UPDATE outbox SET status = 'sent', sent_at = ${now}, provider = ${used}, last_error = NULL WHERE ${mine(row.id)}`;
        report.sent++;
      } else if (result.status === "rejected" || row.attempts >= EMAIL.maxAttempts) {
        update = sql`UPDATE outbox SET status = 'failed', provider = ${used}, last_error = ${result.error} WHERE ${mine(row.id)}`;
        report.failed++;
      } else {
        const next = now + backoffMs(row.attempts, deps.random());
        update = sql`UPDATE outbox SET status = 'queued', next_attempt_at = ${next}, provider = ${used}, last_error = ${result.error} WHERE ${mine(row.id)}`;
        report.retry++;
      }
      await driver.batch([update, ...counts]);
    }
  } finally {
    await Promise.all(providers.map((p) => p.close().catch(() => {})));
  }
  return report;
}

function invalid(r: Claimed): string | null {
  if (!isSafeAddress(r.to_email)) return "invalid recipient address";
  try {
    assertPlainText(r.subject);
    assertPlainText(r.body_text);
  } catch {
    return "emails must not contain emojis";
  }
  if (/[\r\n]/.test(r.subject) || r.subject.length > 300) return "invalid subject";
  if (r.body_text.length > 50_000) return "body too long";
  return null;
}

/** The scheduled entry point: one run plus one log line (counts and D1 rows, never addresses or secrets). */
export async function scheduledSend(env: Env, driver: SqlDriver, deps: SenderDeps): Promise<RunReport> {
  const t0 = Date.now();
  let report: RunReport | null = null;
  try {
    report = await runSender(env, driver, deps);
    return report;
  } finally {
    console.log(JSON.stringify({
      evt: "email_run", ...(report ?? { error: true }),
      d1_queries: driver.usage.queries, rows_read: driver.usage.rows_read, rows_written: driver.usage.rows_written,
      wall_ms: Date.now() - t0,
    }));
  }
}
