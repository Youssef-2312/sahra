// Health messages to the site owners' Discord channel (optional, workstream F).
// The webhook URL is a Cloudflare secret (DISCORD_WEBHOOK_URL) and is never
// stored, logged or shown. Messages are rows in health_discord, added in the same
// batch that decides the email alert; each health run posts at most 3 due rows.
// A failed post (network error, 5xx, 429) stays pending and is retried by later
// runs until 24 hours after it was created; then it is marked gave_up. A 429's
// retry_after is respected. Other 4xx answers (webhook deleted, bad URL) give up
// at once. Email through the outbox stays the primary channel.

import type { SqlDriver } from "../db/driver";
import { sql, type Sql } from "../db/sql";
import { formatHuman } from "../party/time";

export const DISCORD = {
  perRun: 3,
  maxChars: 1900,
  giveUpMs: 24 * 3600_000,
  timeoutMs: 10_000,
  /** Without a retry_after, a failed post waits for the next run (runs are 15 minutes apart). */
  minRetryMs: 60_000,
  keepDays: 8,
} as const;

export type DiscordStatus = "configured" | "not_set" | "invalid";

const WEBHOOK = /^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/[0-9]+\/[A-Za-z0-9_-]+$/;

/** Only Discord's own webhook URLs are used; anything else counts as not configured. */
export function discordStatus(url: string | undefined): DiscordStatus {
  if (!url) return "not_set";
  return WEBHOOK.test(url.trim()) ? "configured" : "invalid";
}

/** Plain text for Discord: no emojis, no mass mentions, at most 1,900 characters. */
export function discordText(s: string): string {
  const clean = s
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/@(everyone|here)/gi, "(at)$1");
  return clean.length > DISCORD.maxChars ? `${clean.slice(0, DISCORD.maxChars - 3)}...` : clean;
}

/** "2026-10-01 18:00 UTC / 2026-10-01 21:00 Cairo". */
export function bothTimes(t: number): string {
  return `${new Date(t).toISOString().slice(0, 16).replace("T", " ")} UTC / ${formatHuman(t, "Africa/Cairo").replace(" (Africa/Cairo)", "")} Cairo`;
}

/** An INSERT for a batch, added only when `guard` holds (idempotent by id). */
export function discordInsert(id: string, content: string, now: number, guard: Sql): Sql {
  return sql`INSERT INTO health_discord (id, created_at, content, status, next_attempt_at)
    SELECT ${id}, ${now}, ${discordText(content)}, 'pending', ${now}
    WHERE ${guard} AND NOT EXISTS (SELECT 1 FROM health_discord WHERE id = ${id})`;
}

export interface DiscordReport { sent: number; retry: number; gave_up: number }

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Posts up to 3 due messages; each result is written in one batch at the end. */
export async function deliverDiscord(main: SqlDriver, url: string, fetcher: Fetch, now: number): Promise<DiscordReport> {
  const report: DiscordReport = { sent: 0, retry: 0, gave_up: 0 };
  const due = (await main.all<{ id: string; created_at: number; content: string }>(sql`SELECT id, created_at, content FROM health_discord
    WHERE status = 'pending' AND next_attempt_at <= ${now} ORDER BY created_at LIMIT ${DISCORD.perRun}`)).results;
  if (!due.length) return report;
  const writes: Sql[] = [];
  for (const m of due) {
    const r = await post(url, fetcher, m.content);
    if (r.ok) {
      report.sent++;
      writes.push(sql`UPDATE health_discord SET status = 'sent', sent_at = ${now}, attempts = attempts + 1, last_error = NULL WHERE id = ${m.id} AND status = 'pending'`);
      continue;
    }
    const next = now + Math.max(r.retryAfterMs ?? 0, DISCORD.minRetryMs);
    const giveUp = r.permanent || next - m.created_at > DISCORD.giveUpMs;
    if (giveUp) report.gave_up++; else report.retry++;
    writes.push(sql`UPDATE health_discord SET status = ${giveUp ? "gave_up" : "pending"}, next_attempt_at = ${next},
      attempts = attempts + 1, last_error = ${r.error} WHERE id = ${m.id} AND status = 'pending'`);
  }
  await main.batch(writes);
  return report;
}

async function post(url: string, fetcher: Fetch, content: string): Promise<{ ok: boolean; permanent?: boolean; retryAfterMs?: number; error?: string }> {
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(DISCORD.timeoutMs),
    });
  } catch (e) {
    // Never the URL (it is the secret): only the error's kind.
    return { ok: false, error: `network error: ${(e as Error)?.name ?? "error"}` };
  }
  if (res.ok) return { ok: true };
  let retryAfterMs: number | undefined;
  if (res.status === 429) {
    const body = (await res.json().catch(() => ({}))) as { retry_after?: unknown };
    const s = Number(body.retry_after ?? res.headers.get("retry-after"));
    if (Number.isFinite(s) && s > 0) retryAfterMs = Math.ceil(s * 1000);
  } else {
    await res.body?.cancel();
  }
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429 && res.status !== 408;
  return { ok: false, permanent, retryAfterMs, error: `HTTP ${res.status}` };
}

/** Delivery state for the site owner page (never the URL). */
export function discordView(ok: Sql): Sql[] {
  return [
    sql`SELECT status, COUNT(*) AS n FROM health_discord WHERE ${ok} GROUP BY status`,
    sql`SELECT created_at, status, attempts, last_error, sent_at FROM health_discord WHERE ${ok} ORDER BY created_at DESC LIMIT 1`,
  ];
}
