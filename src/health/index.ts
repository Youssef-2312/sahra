// Unattended health checks (workstream F). The once-a-minute cron (src/index.ts)
// runs them every 15 minutes, in their own waitUntil so the email sender is not
// slowed down, and never while MAINTENANCE is "1" (a controlled recovery).
//
// One run:
//   1. Take the lease in health_state (one conditional UPDATE): two overlapping
//      runs never both work.
//   2. Checks, each with a bounded number of queries:
//      changelog   parties/staff/invites/platform rows with rev > logged_rev are
//                  flushed to the ledger exactly like flushChangeLog does (it is
//                  idempotent); a problem only if they cannot be written. The
//                  daily run also looks for tickets left unlogged (rows with
//                  rev > logged_rev whose last change is not an admission).
//      admissions  every admission since the last run has its ledger record.
//                  Admissions are only possible while a party is open, so only
//                  parties whose control object is open or changed since the last
//                  run are looked at (tickets_party_status index), and only up to
//                  2 minutes ago (a scan still writing its record is not missing).
//      outbox      emails failed in the last 24 hours, waiting more than an hour,
//                  or stuck in "sending".
//      db_size     each database (main, ledger, files where bound) past 70% of
//                  500 MB, or all of them past 70% of 5 GB.
//      backup      the last successful backup (written by the backup job) is
//                  older than its schedule allows.
//      usage       the app's own estimate of today's rows written passes 50% of
//                  the account's 100,000 per day.
//   3. One batch: each check's row, alerts to every active site owner through the
//      outbox (at most one per problem per 6 hours, decided inside the statement,
//      and one "resolved" message when it clears), the cursors and the estimate,
//      and the lease released.
// The daily run (first run after 06:00 UTC) also deletes old per-party counters
// and sends each site owner a short summary, so a missing summary tells the owner
// the checks themselves stopped.

import { flushChangeLog, LogPendingError } from "../changelog";
import { Db } from "../db";
import type { SqlDriver } from "../db/driver";
import { inList, sql, type Sql } from "../db/sql";
import { D1Ledger } from "../ledger";
import { newId } from "../lib/crypto";
import { ACCOUNT_DAILY_WRITES, BUDGET_STOP_AT, dayOf, DAY_MS } from "../limits";
import { outboxInsert } from "../outbox";
import { PLATFORM } from "../platform/db";
import { bothTimes, deliverDiscord, DISCORD, discordInsert, discordStatus, discordView, type DiscordReport, type DiscordStatus } from "./discord";

const MIN = 60_000;
const HOUR = 3600_000;

export const HEALTH = {
  /** The cron runs every minute; the checks run on minutes divisible by this. */
  everyMinutes: 15,
  /** A run that has not finished by then is taken over by a later one. */
  leaseMs: 10 * MIN,
  /** At most one alert per problem in this time. */
  realertMs: 6 * HOUR,
  /** Admissions newer than this are not checked yet (their ledger write may be in flight). */
  admissionGraceMs: 2 * MIN,
  /** First run (no cursor yet): look back this far. */
  admissionFirstLookbackMs: 24 * HOUR,
  /** Admissions checked per run; the rest wait for the next run. */
  admissionsPerRun: 200,
  /** Ledger lookups per statement (2 bound values each; D1 allows 100 per statement). */
  ledgerChunk: 40,
  /** Missing admission records remembered (and re-checked) at most. */
  missingKept: 50,
  /** Change-log rounds per run (flushChangeLog writes at most 20 entries per round). */
  flushRounds: 3,
  outboxLateMs: HOUR,
  outboxStuckMs: 30 * MIN,
  outboxFailedWindowMs: 24 * HOUR,
  /** D1 Free: 500 MB per database, 5 GB per account. Warn at 70%. */
  dbBytes: 500 * 1000 * 1000,
  accountBytes: 5 * 1000 * 1000 * 1000,
  sizeWarn: 0.7,
  /** The backup is daily (workstream E); alert when the last one is older than this. */
  backupMaxAgeMs: 26 * HOUR,
  /** The daily part runs in the first run at or after this UTC hour. */
  dailyHourUtc: 6,
  /** Rows written per counted event, for the daily estimate (see DECISIONS "Workstream F"). */
  weights: { audit: 6, outbox: 3, admission: 4, emailSent: 5 },
  /** Delete per-party counters older than this many days. */
  usageKeepDays: 8,
} as const;

export type CheckId = "changelog" | "admissions" | "outbox" | "db_size" | "backup" | "usage";
export const CHECK_TITLES: Record<CheckId, string> = {
  changelog: "Change log (ledger) writes",
  admissions: "Admissions recorded in the ledger",
  outbox: "Email outbox",
  db_size: "Database size",
  backup: "Backup",
  usage: "Daily usage estimate",
};

export interface CheckResult {
  id: CheckId;
  status: "ok" | "problem" | "unknown";
  summary: string;
  detail?: Record<string, unknown>;
}

export interface HealthDeps {
  main: SqlDriver;
  ledger: SqlDriver;
  now: () => number;
  /** Bytes per database, from D1's own figure (meta.size_after); null = not bound. */
  sizes: () => Promise<Record<string, number | null>>;
  maintenance: boolean;
  /** An email provider is configured (only changes the wording of the outbox check). */
  emailConfigured: boolean;
  origin: string;
  /** Optional Discord webhook (secret); used only if discordStatus() says "configured". */
  discordUrl?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface HealthReport {
  skipped?: "maintenance" | "busy";
  daily?: boolean;
  checks?: Record<string, string>;
  alerts?: number;
  admissions_checked?: number;
  usage_est?: number;
  discord?: DiscordReport | "not_configured" | "error";
  main: { queries: number; rows_read: number; rows_written: number };
  ledger: { queries: number; rows_read: number; rows_written: number };
}

interface State {
  last_backup_at: number | null;
  last_backup_note: string | null;
  admissions_to: number | null;
  audit_seen_id: number | null;
  outbox_seen_at: number | null;
  usage_day: number;
  usage_base: number;
  daily_day: number;
}

interface CheckRow {
  id: string;
  status: string;
  summary: string;
  detail: string | null;
  since: number;
  alerted_at: number | null;
}

/** True on the cron minutes the checks run (every 15 minutes). */
export function isHealthMinute(scheduledTime: number): boolean {
  return Math.floor(scheduledTime / MIN) % HEALTH.everyMinutes === 0;
}

const usageOf = (d: SqlDriver) => ({ queries: d.usage.queries, rows_read: d.usage.rows_read, rows_written: d.usage.rows_written });

function errText(e: unknown): string {
  return String((e as Error)?.message ?? e).replace(/\s+/g, " ").slice(0, 160);
}

export async function runHealth(deps: HealthDeps): Promise<HealthReport> {
  const { main, ledger } = deps;
  const report = (): HealthReport => ({ main: usageOf(main), ledger: usageOf(ledger) });
  // A controlled recovery is running: no reads, no writes.
  if (deps.maintenance) return { ...report(), skipped: "maintenance" };
  const now = deps.now();
  const op = newId();

  // 1. Lease (and the state, in the same statement).
  const leased = await main.all<State>(sql`UPDATE health_state SET lease_until = ${now + HEALTH.leaseMs}, lease_op = ${op}
    WHERE id = 'main' AND lease_until <= ${now}
    RETURNING last_backup_at, last_backup_note, admissions_to, audit_seen_id, outbox_seen_at, usage_day, usage_base, daily_day`);
  const state = leased.results[0];
  if (!state) return { ...report(), skipped: "busy" };

  const today = dayOf(now);
  const daily = state.daily_day < today && now - today * DAY_MS >= HEALTH.dailyHourUtc * HOUR;
  const prev = new Map((await main.all<CheckRow>(sql`SELECT id, status, summary, detail, since, alerted_at FROM health_checks`)).results.map((r) => [r.id, r]));

  // 2. Checks. A check that throws reports a problem (its database may be failing).
  const results: CheckResult[] = [];
  const guarded = async (id: CheckId, f: () => Promise<CheckResult>) => {
    try {
      results.push(await f());
    } catch (e) {
      results.push({ id, status: "problem", summary: `The check could not run: ${errText(e)}` });
    }
  };
  await guarded("changelog", () => checkChangeLog(main, ledger, now, daily));
  let admissions = { checked: 0, to: state.admissions_to };
  await guarded("admissions", async () => {
    const r = await checkAdmissions(main, ledger, now, state.admissions_to, prev.get("admissions"));
    admissions = { checked: r.checked, to: r.to };
    return r.result;
  });
  await guarded("outbox", () => checkOutbox(main, now, deps.emailConfigured));
  await guarded("db_size", () => checkSizes(deps));
  results.push(checkBackup(state, now));

  // Daily write estimate (cheap aggregates; see DECISIONS "Workstream F").
  const est = await estimateUsage(main, state, now, admissions.checked);
  results.push(est.usage_est >= BUDGET_STOP_AT
    ? { id: "usage", status: "problem", summary: `Estimated rows written today: ${est.usage_est} of ${ACCOUNT_DAILY_WRITES}. Guest notices, email approvals and exports are paused until 00:00 UTC.`, detail: { usage_est: est.usage_est } }
    : { id: "usage", status: "ok", summary: `Estimated rows written today are below ${Math.round((BUDGET_STOP_AT / ACCOUNT_DAILY_WRITES) * 100)}% of ${ACCOUNT_DAILY_WRITES}.` });

  // 3. One batch: check rows, alerts, state, lease released.
  const changes = results.filter((r) => wantsMessage(r, prev.get(r.id), now));
  const owners = changes.length || daily
    ? (await main.all<{ id: string; email: string }>(sql`SELECT id, email FROM platform_admins WHERE disabled_at IS NULL`)).results
    : [];
  const discord = discordStatus(deps.discordUrl) === "configured" && !!deps.fetch;
  const writes: Sql[] = [];
  for (const r of results) {
    // A check whose state is unchanged writes nothing (the page shows the run time from health_state).
    const p = prev.get(r.id);
    const same = p && p.status === r.status && p.summary === r.summary && p.detail === (r.detail ? JSON.stringify(r.detail) : null);
    if (same && !changes.includes(r)) continue;
    writes.push(upsertCheck(r, now, op));
    // After the check's row: the guard needs this run's alert_op (same 6-hour rule as the email).
    if (discord && changes.includes(r)) {
      writes.push(discordInsert(`discord:${op}:${r.id}`, discordMessage(r, prev.get(r.id), now, deps.origin), now,
        sql`EXISTS (SELECT 1 FROM health_checks WHERE id = ${r.id} AND alert_op = ${op})`));
    }
    for (const o of owners) {
      if (!changes.includes(r)) continue;
      const msg = message(r, prev.get(r.id), deps.origin);
      writes.push(outboxInsert({
        id: `health:${op}:${r.id}:${o.id}`, partyId: PLATFORM, kind: "health_alert", toEmail: o.email,
        subject: msg.subject, bodyText: msg.body, now, createdBy: null, needsApproval: false,
      }, sql`EXISTS (SELECT 1 FROM health_checks WHERE id = ${r.id} AND alert_op = ${op})`));
    }
  }
  if (daily) {
    const msg = dailySummary(results, est.usage_est, now, deps.origin);
    for (const o of owners) {
      const id = `health-daily:${today}:${o.id}`;
      writes.push(outboxInsert({
        id, partyId: PLATFORM, kind: "health_summary", toEmail: o.email,
        subject: msg.subject, bodyText: msg.body, now, createdBy: null, needsApproval: false,
      }, sql`NOT EXISTS (SELECT 1 FROM outbox WHERE id = ${id})`));
    }
    writes.push(sql`DELETE FROM party_usage WHERE day < ${today - HEALTH.usageKeepDays}`);
    writes.push(sql`DELETE FROM health_discord WHERE status != 'pending' AND created_at < ${now - DISCORD.keepDays * DAY_MS}`);
    if (discord) {
      writes.push(discordInsert(`discord-daily:${today}`, `${msg.subject}\n${bothTimes(now)}\n${msg.lines.join("\n")}\n`
        + `Estimated rows written today: ${est.usage_est} of ${ACCOUNT_DAILY_WRITES}.\n${deps.origin}/platform`, now, sql`1`));
    }
  }
  const runReport = {
    checks: Object.fromEntries(results.map((r) => [r.id, r.status])),
    admissions_checked: admissions.checked,
    usage_est: est.usage_est,
    daily,
  };
  writes.push(sql`UPDATE health_state SET lease_until = 0, lease_op = NULL, last_run_at = ${now}, last_run_report = ${JSON.stringify(runReport)},
      admissions_to = ${admissions.to}, audit_seen_id = ${est.audit_seen_id}, outbox_seen_at = ${now},
      usage_day = ${today}, usage_base = ${est.usage_base}, usage_est = ${est.usage_est},
      daily_day = ${daily ? today : state.daily_day}
    WHERE id = 'main' AND lease_op = ${op}`);
  await main.batch(writes);

  // Discord (extra channel): at most 3 posts per run, after the state is saved.
  let discordReport: HealthReport["discord"] = "not_configured";
  if (discord) {
    try {
      discordReport = await deliverDiscord(main, deps.discordUrl!.trim(), deps.fetch!, now);
    } catch (e) {
      discordReport = "error";
      console.error(JSON.stringify({ evt: "health_discord_error", message: errText(e) }));
    }
  }

  const out: HealthReport = {
    ...report(), daily, checks: runReport.checks, alerts: changes.length * owners.length,
    admissions_checked: admissions.checked, usage_est: est.usage_est, discord: discordReport,
  };
  console.log(JSON.stringify({ evt: "health", ...out }));
  return out;
}

// ----------------------------------------------------------------- alerting

/** Whether this result should tell the site owners now (the statement decides again, atomically). */
function wantsMessage(r: CheckResult, prev: CheckRow | undefined, now: number): boolean {
  if (r.status === "problem") return prev?.status !== "problem" || prev.alerted_at == null || prev.alerted_at <= now - HEALTH.realertMs;
  return prev?.status === "problem" && prev.alerted_at != null;
}

/**
 * The check's row. alert_op is set to this run's op only when an alert is due:
 * a new problem, a problem last alerted 6 or more hours ago, or a problem that was
 * alerted and is now clear ("resolved"). The outbox rows require it.
 */
function upsertCheck(r: CheckResult, now: number, op: string): Sql {
  const detail = r.detail ? JSON.stringify(r.detail) : null;
  if (r.status === "problem") {
    const due = sql`(status != 'problem' OR alerted_at IS NULL OR alerted_at <= ${now - HEALTH.realertMs})`;
    return sql`INSERT INTO health_checks (id, status, summary, detail, since, checked_at, alerted_at, alert_op)
      VALUES (${r.id}, 'problem', ${r.summary}, ${detail}, ${now}, ${now}, ${now}, ${op})
      ON CONFLICT (id) DO UPDATE SET
        since = CASE WHEN status = 'problem' THEN since ELSE ${now} END,
        alerted_at = CASE WHEN ${due} THEN ${now} ELSE alerted_at END,
        alert_op = CASE WHEN ${due} THEN ${op} ELSE alert_op END,
        status = 'problem', summary = excluded.summary, detail = excluded.detail, checked_at = ${now}`;
  }
  return sql`INSERT INTO health_checks (id, status, summary, detail, since, checked_at, alerted_at, alert_op)
    VALUES (${r.id}, ${r.status}, ${r.summary}, ${detail}, ${now}, ${now}, NULL, NULL)
    ON CONFLICT (id) DO UPDATE SET
      since = CASE WHEN status = excluded.status THEN since ELSE ${now} END,
      alert_op = CASE WHEN status = 'problem' AND alerted_at IS NOT NULL THEN ${op} ELSE NULL END,
      alerted_at = NULL,
      status = excluded.status, summary = excluded.summary, detail = excluded.detail, checked_at = ${now}`;
}

function when(t: number): string {
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function message(r: CheckResult, prev: CheckRow | undefined, origin: string) {
  const title = CHECK_TITLES[r.id];
  const page = `${origin}/platform`;
  if (r.status === "problem") {
    const again = prev?.status === "problem" ? `Still a problem since ${when(prev.since)}.\n\n` : "";
    return {
      subject: `Sahra health: ${title} needs attention`,
      body: `${again}${title}: ${r.summary}\n\nDetails and the other checks: ${page}\n\nYou get at most one message per problem every 6 hours, and one when it is resolved. Party owners are not told about this.\n`,
    };
  }
  return {
    subject: `Sahra health: ${title} resolved`,
    body: `${title} is back to normal: ${r.summary}\n\nIt was a problem since ${prev ? when(prev.since) : "earlier"}.\n\nAll checks: ${page}\n`,
  };
}

/** The Discord text of an alert or "resolved" message: check, state, short detail, time in UTC and Cairo. */
function discordMessage(r: CheckResult, prev: CheckRow | undefined, now: number, origin: string): string {
  const title = CHECK_TITLES[r.id];
  const head = r.status === "problem"
    ? `Sahra health: PROBLEM - ${title}${prev?.status === "problem" ? ` (still, since ${bothTimes(prev.since)})` : ""}`
    : `Sahra health: resolved - ${title}`;
  return `${head}\n${r.summary}\n${bothTimes(now)}\n${origin}/platform`;
}

function dailySummary(results: CheckResult[], usageEst: number, now: number, origin: string) {
  const problems = results.filter((r) => r.status === "problem");
  const lines = results.map((r) => `- ${CHECK_TITLES[r.id]}: ${r.status === "ok" ? "ok" : r.status === "unknown" ? "not set up" : "PROBLEM"}. ${r.summary}`);
  return {
    subject: problems.length ? `Sahra daily check: ${problems.length} problem${problems.length > 1 ? "s" : ""}` : "Sahra daily check: all ok",
    lines,
    body: `Daily summary of the automatic checks, ${when(now)}.\n\n${lines.join("\n")}\n\nEstimated rows written today so far: ${usageEst} of ${ACCOUNT_DAILY_WRITES} (an estimate; the exact figure is in the Cloudflare dashboard).\n\nThis message comes once a day. If it stops coming, the checks themselves are not running.\n\nAll checks: ${origin}/platform\n`,
  };
}

// ------------------------------------------------------------------- checks

async function checkChangeLog(main: SqlDriver, ledger: SqlDriver, now: number, daily: boolean): Promise<CheckResult> {
  const db = new Db(main);
  const led = new D1Ledger(ledger);
  let flushed = 0;
  // Tickets are not scanned every run (there can be thousands); once a day, the
  // ones whose latest change is not an admission and is not yet logged.
  const tickets = daily
    ? (await main.all<{ id: string }>(sql`SELECT id FROM tickets WHERE rev > logged_rev
        AND (last_action IS NULL OR last_action != 'admitted') LIMIT 20`)).results.map((r) => r.id)
    : [];
  for (let round = 0; round < HEALTH.flushRounds; round++) {
    try {
      flushed += await flushChangeLog(db, led, now, round === 0 ? tickets : []);
      return { id: "changelog", status: "ok", summary: "Nothing pending." };
    } catch (e) {
      if (e instanceof LogPendingError && e.cause === "backlog") {
        flushed += 20;
        continue;
      }
      return {
        id: "changelog", status: "problem",
        summary: `Changes are waiting for their change-log entry and could not be written to the ledger: ${errText(e instanceof LogPendingError ? e.cause : e)}`,
      };
    }
  }
  return { id: "changelog", status: "problem", summary: `More than ${HEALTH.flushRounds * 20} change-log entries were pending; the next run continues.`, detail: { flushed } };
}

async function checkAdmissions(main: SqlDriver, ledger: SqlDriver, now: number, from: number | null, prev: CheckRow | undefined) {
  const since = from ?? now - HEALTH.admissionFirstLookbackMs;
  const upto = now - HEALTH.admissionGraceMs;
  let to = Math.max(since, upto);
  let found: { id: string; used_at: number }[] = [];
  if (upto > since) {
    // Parties that could have admitted anyone since `since` (a small table in the ledger).
    const parties = (await ledger.all<{ party_id: string }>(sql`SELECT party_id FROM party_control
      WHERE state = 'open' OR updated_at > ${since - HEALTH.leaseMs}`)).results.map((r) => r.party_id);
    for (let i = 0; i < parties.length && found.length <= HEALTH.admissionsPerRun; i += HEALTH.ledgerChunk) {
      const chunk = parties.slice(i, i + HEALTH.ledgerChunk);
      const rows = (await main.all<{ id: string; used_at: number }>(sql`SELECT id, used_at FROM tickets
        WHERE party_id IN (${inList(chunk)}) AND used_at > ${since} AND used_at <= ${upto}
        ORDER BY used_at LIMIT ${HEALTH.admissionsPerRun + 1}`)).results;
      found = found.concat(rows);
    }
    found.sort((a, b) => a.used_at - b.used_at);
    if (found.length > HEALTH.admissionsPerRun) {
      found = found.slice(0, HEALTH.admissionsPerRun);
      // Ties at the boundary are read again next time (the check is idempotent).
      to = found.at(-1)!.used_at - 1;
    }
  }
  const remembered = ((prev?.detail ? JSON.parse(prev.detail) : {}) as { missing?: string[] }).missing ?? [];
  const ids = [...new Set([...remembered, ...found.map((r) => r.id)])];
  const recorded = new Set<string>();
  if (ids.length) {
    const stmts: Sql[] = [];
    for (let i = 0; i < ids.length; i += HEALTH.ledgerChunk) {
      const ranges = ids.slice(i, i + HEALTH.ledgerChunk).map((id) => sql`(event_id >= ${`ticket:${id}:`} AND event_id < ${`ticket:${id};`})`);
      stmts.push(sql`SELECT entity_id FROM change_log WHERE action = 'admitted' AND (${joinOr(ranges)})`);
    }
    for (const r of await ledger.batch(stmts)) for (const row of r.results) recorded.add(String(row.entity_id));
  }
  const missing = ids.filter((id) => !recorded.has(id)).slice(0, HEALTH.missingKept);
  const result: CheckResult = missing.length
    ? {
      id: "admissions", status: "problem",
      summary: `${missing.length} admitted ticket${missing.length > 1 ? "s have" : " has"} no admission record in the ledger. The door showed "recording" for these and the scanner may not have retried; check them before any database recovery.`,
      detail: { missing },
    }
    : { id: "admissions", status: "ok", summary: "Every admission checked has its ledger record." };
  return { result, checked: found.length, to };
}

function joinOr(parts: Sql[]): Sql {
  return parts.slice(1).reduce((acc, p) => sql`${acc} OR ${p}`, parts[0]!);
}

async function checkOutbox(main: SqlDriver, now: number, emailConfigured: boolean): Promise<CheckResult> {
  const capped = (cond: Sql) => sql`(SELECT COUNT(*) FROM (SELECT 1 FROM outbox WHERE ${cond} LIMIT 1000))`;
  const r = (await main.all<{ failed: number; late: number; stuck: number }>(sql`SELECT
      ${capped(sql`status = 'failed' AND next_attempt_at > ${now - HEALTH.outboxFailedWindowMs}`)} AS failed,
      ${capped(sql`status = 'queued' AND next_attempt_at <= ${now - HEALTH.outboxLateMs}`)} AS late,
      ${capped(sql`status = 'sending' AND next_attempt_at <= ${now - HEALTH.outboxStuckMs}`)} AS stuck`)).results[0]!;
  const failed = Number(r.failed), late = Number(r.late), stuck = Number(r.stuck);
  const parts: string[] = [];
  if (failed) parts.push(`${failed} email${failed > 1 ? "s" : ""} failed in the last 24 hours`);
  if (late) parts.push(`${late} waiting to be sent for more than an hour${emailConfigured ? " (the daily sending cap may be reached)" : " (no email provider is configured)"}`);
  if (stuck) parts.push(`${stuck} stuck while sending`);
  return parts.length
    ? { id: "outbox", status: "problem", summary: `${parts.join("; ")}.`, detail: { failed, late, stuck } }
    : { id: "outbox", status: "ok", summary: "No failed, late or stuck emails.", detail: { failed, late, stuck } };
}

async function checkSizes(deps: HealthDeps): Promise<CheckResult> {
  const sizes = await deps.sizes();
  const over: string[] = [];
  let total = 0;
  for (const [name, bytes] of Object.entries(sizes)) {
    if (bytes == null) continue;
    total += bytes;
    if (bytes >= HEALTH.dbBytes * HEALTH.sizeWarn) over.push(`${name} ${mb(bytes)} of ${mb(HEALTH.dbBytes)}`);
  }
  if (total >= HEALTH.accountBytes * HEALTH.sizeWarn) over.push(`all databases ${mb(total)} of ${mb(HEALTH.accountBytes)} (staging counts too)`);
  const list = Object.entries(sizes).filter(([, b]) => b != null).map(([n, b]) => `${n} ${mb(b!)}`).join(", ");
  return over.length
    ? { id: "db_size", status: "problem", summary: `Past 70%: ${over.join("; ")}.`, detail: sizes }
    : { id: "db_size", status: "ok", summary: `Below 70%: ${list}.` };
}

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

function checkBackup(state: State, now: number): CheckResult {
  if (state.last_backup_at == null) return { id: "backup", status: "unknown", summary: "No backup recorded yet (the backup job is not set up)." };
  const age = now - state.last_backup_at;
  const detail = { last_backup_at: state.last_backup_at, note: state.last_backup_note };
  return age > HEALTH.backupMaxAgeMs
    ? { id: "backup", status: "problem", summary: `The last successful backup was ${Math.floor(age / HOUR)} hours ago (${when(state.last_backup_at)}); it should be daily.`, detail }
    : { id: "backup", status: "ok", summary: `Last successful backup ${when(state.last_backup_at)}.`, detail };
}

/**
 * The app's own estimate of today's rows written, from cheap aggregates: new
 * audit rows (primary key range), new outbox rows (outbox_party index), the
 * admissions this run checked, and today's emails sent (email_quota). Each is
 * multiplied by the rows a typical event writes. Denied scans, session
 * revocations and outbox approvals are not counted (the weights carry a margin).
 */
async function estimateUsage(main: SqlDriver, state: State, now: number, admissions: number) {
  const today = dayOf(now);
  const w = HEALTH.weights;
  const rs = await main.batch([
    state.audit_seen_id == null
      ? sql`SELECT 0 AS n, (SELECT MAX(id) FROM audit) AS max_id`
      : sql`SELECT COUNT(*) AS n, MAX(id) AS max_id FROM audit WHERE id > ${state.audit_seen_id}`,
    state.outbox_seen_at == null
      ? sql`SELECT 0 AS n`
      : sql`SELECT COUNT(*) AS n FROM parties p JOIN outbox o ON o.party_id = p.id AND o.created_at > ${state.outbox_seen_at} AND o.created_at <= ${now}`,
    sql`SELECT COALESCE(SUM(sent), 0) AS n FROM email_quota WHERE provider IN ('gmail', 'brevo') AND hour >= ${today * 24}`,
  ]);
  const audit = Number(rs[0]!.results[0]?.n ?? 0);
  const maxId = rs[0]!.results[0]?.max_id;
  const outbox = Number(rs[1]!.results[0]?.n ?? 0);
  const sent = Number(rs[2]!.results[0]?.n ?? 0);
  // This run's own writes so far, plus a margin for its final batch.
  const own = main.usage.rows_written + 10;
  const base = (state.usage_day === today ? state.usage_base : 0) + audit * w.audit + outbox * w.outbox + admissions * w.admission + own;
  return {
    audit_seen_id: maxId == null ? (state.audit_seen_id ?? 0) : Number(maxId),
    usage_base: base,
    usage_est: base + sent * w.emailSent,
  };
}

// --------------------------------------------------------------- site owner

/** The site owner page: checks, last run, recent alerts, today's per-party counters. Read-only. */
export async function healthView(main: SqlDriver, ok: Sql, now: number, discord: DiscordStatus) {
  const rs = await main.batch([
    sql`SELECT id, status, summary, detail, since, checked_at, alerted_at FROM health_checks WHERE ${ok} ORDER BY id`,
    sql`SELECT last_run_at, last_run_report, last_backup_at, last_backup_note, usage_day, usage_est FROM health_state WHERE id = 'main' AND ${ok}`,
    sql`SELECT created_at, kind, subject, status FROM outbox WHERE party_id = ${PLATFORM} AND ${ok} ORDER BY created_at DESC LIMIT 40`,
    sql`SELECT party_id, kind, n FROM party_usage WHERE day = ${dayOf(now)} AND ${ok} ORDER BY party_id, kind`,
    ...discordView(ok),
  ]);
  const st = rs[1]!.results[0] as undefined | Record<string, unknown>;
  // One alert goes to every site owner: show it once, with its recipients' states.
  const alerts: { at: number; kind: string; subject: string; statuses: Record<string, number> }[] = [];
  for (const r of rs[2]!.results as { created_at: number; kind: string; subject: string; status: string }[]) {
    let a = alerts.find((x) => x.at === r.created_at && x.subject === r.subject);
    if (!a) alerts.push(a = { at: r.created_at, kind: r.kind, subject: r.subject, statuses: {} });
    a.statuses[r.status] = (a.statuses[r.status] ?? 0) + 1;
  }
  return {
    checks: (rs[0]!.results as Record<string, unknown>[]).map((r) => ({
      ...r, title: CHECK_TITLES[r.id as CheckId] ?? r.id, detail: r.detail ? JSON.parse(String(r.detail)) : null,
    })),
    last_run_at: st?.last_run_at ?? null,
    last_run: st?.last_run_report ? JSON.parse(String(st.last_run_report)) : null,
    backup: { last_at: st?.last_backup_at ?? null, note: st?.last_backup_note ?? null },
    usage: {
      estimated_rows_written_today: st && Number(st.usage_day) === dayOf(now) ? Number(st.usage_est) : 0,
      daily_allowance: ACCOUNT_DAILY_WRITES,
      non_essential_stop_at: BUDGET_STOP_AT,
    },
    alerts,
    party_usage_today: rs[3]!.results,
    // Never the webhook URL: only whether it is set and valid, and the latest delivery.
    discord: {
      status: discord,
      messages: Object.fromEntries((rs[4]!.results as { status: string; n: number }[]).map((r) => [r.status, Number(r.n)])),
      latest: rs[5]!.results[0] ?? null,
    },
  };
}

/**
 * Bytes per database as D1 reports them (meta.size_after of a trivial query: no
 * rows read, nothing written). `PRAGMA page_count` is not allowed on D1.
 */
export async function dbSizes(env: { DB: D1Database; LEDGER: D1Database; FILES?: D1Database }): Promise<Record<string, number | null>> {
  const one = async (d?: D1Database) => {
    if (!d) return null;
    const r = await d.prepare("SELECT 1").all();
    const s = Number((r.meta as { size_after?: number }).size_after);
    return Number.isFinite(s) ? s : null;
  };
  const [main, ledger, files] = await Promise.all([one(env.DB), one(env.LEDGER), one(env.FILES)]);
  return { main, ledger, files };
}
