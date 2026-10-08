// Workstream F: unattended health checks with alerts to the site owners, and
// per-party limits. Runs the checks directly (runHealth) with a test clock, plus
// the Worker's scheduled handler for the cadence and MAINTENANCE.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Driver, type SqlDriver } from "../src/db/driver";
import { dbSizes, HEALTH, runHealth, type HealthDeps } from "../src/health";
import { discordStatus, discordText } from "../src/health/discord";
import { newId } from "../src/lib/crypto";
import { BUDGET_STOP_AT, charge, dayOf, DAY_MS, LIMITS } from "../src/limits";
import {
  api, Clock, guestParty, harness, openParty, ORIGIN, papi, scan, seedDoor, seedOrganiser, seedOwner, seedParty,
  seedPlatformSession, seedSiteOwner, signup, testTickets,
} from "./helpers";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
});
afterEach(() => vi.restoreAllMocks());

function lastReq() {
  const l = logs.filter((x) => x.startsWith('{"evt":"req"')).at(-1);
  return JSON.parse(l!) as { route: string; status: number; d1_queries: number; rows_read: number; rows_written: number; ledger_rows_written: number };
}

let clock: Clock;
let sizes: Record<string, number | null>;
let owners: { id: string; email: string }[];

/** Fresh health state for each test (the database is shared by the tests of this file). */
beforeEach(async () => {
  clock = new Clock();
  sizes = { main: 2e6, ledger: 1e6, files: 1e6 };
  await env.DB.batch([
    env.DB.prepare("DELETE FROM health_checks"),
    env.DB.prepare("DELETE FROM outbox"),
    env.DB.prepare("DELETE FROM party_usage"),
    env.DB.prepare("UPDATE platform_admins SET disabled_at = 1 WHERE disabled_at IS NULL"),
    // Cursors at "now" (earlier tests' admissions are not re-checked); the daily part already done today.
    env.DB.prepare(`UPDATE health_state SET lease_until = 0, lease_op = NULL, last_backup_at = NULL, last_backup_note = NULL,
      admissions_to = ?, audit_seen_id = NULL, outbox_seen_at = NULL, usage_day = 0, usage_base = 0, usage_est = 0, daily_day = ?
      WHERE id = 'main'`).bind(clock.now(), dayOf(clock.now())),
  ]);
  // Earlier tests' parties: paused long ago, so their admissions are not looked at again.
  await env.LEDGER.prepare("UPDATE party_control SET state = 'paused', updated_at = 0").run();
  owners = [];
  for (let i = 0; i < 2; i++) {
    const o = await seedSiteOwner();
    owners.push({ id: o.id, email: `${o.sub}@gmail.com` });
  }
});

const deps = (over: Partial<HealthDeps> = {}): HealthDeps => ({
  main: new D1Driver(env.DB), ledger: new D1Driver(env.LEDGER), now: clock.now, sizes: async () => ({ ...sizes }),
  maintenance: false, emailConfigured: true, origin: ORIGIN, ...over,
});
const run = (over: Partial<HealthDeps> = {}) => runHealth(deps(over));

async function check(id: string) {
  return env.DB.prepare("SELECT status, summary, detail, alerted_at FROM health_checks WHERE id = ?").bind(id)
    .first<{ status: string; summary: string; detail: string | null; alerted_at: number | null }>();
}

async function alerts() {
  return (await env.DB.prepare("SELECT party_id, kind, to_email, subject, body_text, status FROM outbox WHERE kind IN ('health_alert', 'health_summary') ORDER BY created_at, subject, to_email").all<{
    party_id: string; kind: string; to_email: string; subject: string; body_text: string; status: string;
  }>()).results;
}

/** Ledger driver whose batches (change-log writes) fail, reads work. */
class FailingWrites implements SqlDriver {
  constructor(private readonly inner: SqlDriver) {}
  get usage() { return this.inner.usage; }
  all<T>(q: Parameters<SqlDriver["all"]>[0]) { return this.inner.all<T>(q); }
  async batch(): Promise<never> { throw new Error("D1_ERROR: injected ledger failure"); }
}

describe("health checks", () => {
  it("an idle run: every check ok, bounded queries, a handful of writes", async () => {
    await env.DB.prepare("UPDATE health_state SET last_backup_at = ? WHERE id = 'main'").bind(clock.now() - 3600_000).run();
    const r = await run();
    expect(r.checks).toEqual({ changelog: "ok", admissions: "ok", outbox: "ok", db_size: "ok", backup: "ok", usage: "ok" });
    expect(r.alerts).toBe(0);
    expect(await alerts()).toEqual([]);
    // Bounded: lease, check rows, change-log check, party list (ledger), outbox, estimate, final batch.
    expect(r.main.queries).toBeLessThanOrEqual(8);
    expect(r.ledger.queries).toBeLessThanOrEqual(2);
    // Steady state: an unchanged check writes nothing; only the lease and the run's state row.
    clock.advance(15 * 60_000);
    const r2 = await run();
    expect([r2.main.rows_written, r2.ledger.rows_written]).toEqual([2, 0]);
    // Same, with a Discord webhook configured and nothing to post: one more read.
    clock.advance(15 * 60_000);
    const r3 = await run({ discordUrl: "https://discord.com/api/webhooks/1/test-only", fetch: async () => new Response(null, { status: 204 }) });
    expect(r3.discord).toEqual({ sent: 0, retry: 0, gave_up: 0 });
    expect(r3.main.queries).toBe(r2.main.queries + 1);
    expect(r3.main.rows_written).toBe(2);
    console.error(JSON.stringify({ evt: "measure", what: "health_run_idle_local", first: { main: r.main, ledger: r.ledger }, steady: { main: r2.main, ledger: r2.ledger }, steady_discord: { main: r3.main, ledger: r3.ledger } }));
  });

  it("change log: pending rows are flushed; when the ledger refuses, the owners are told once, and again when it clears", async () => {
    const p = `p${newId().slice(0, 8)}`;
    await env.DB.prepare("INSERT INTO parties (id, name, capacity, created_at, rev, logged_rev) VALUES (?, 'x', 10, 0, 2, 0)").bind(p).run();
    expect((await run()).checks!.changelog).toBe("ok");
    expect(await env.DB.prepare("SELECT logged_rev FROM parties WHERE id = ?").bind(p).first("logged_rev")).toBe(2);
    expect(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM change_log WHERE event_id = ?").bind(`party:${p}:2`).first("n")).toBe(1);

    await env.DB.prepare("UPDATE parties SET rev = 3 WHERE id = ?").bind(p).run();
    clock.advance(15 * 60_000);
    const r = await run({ ledger: new FailingWrites(new D1Driver(env.LEDGER)) });
    expect(r.checks!.changelog).toBe("problem");
    expect((await check("changelog"))!.summary).toMatch(/could not be written to the ledger/);
    expect((await alerts()).map((a) => [a.to_email, a.subject])).toEqual(owners.map((o) => [o.email, "Sahra health: Change log (ledger) writes needs attention"]).sort());

    clock.advance(15 * 60_000);
    expect((await run()).checks!.changelog).toBe("ok");
    expect(await env.DB.prepare("SELECT logged_rev FROM parties WHERE id = ?").bind(p).first("logged_rev")).toBe(3);
    expect((await alerts()).filter((a) => a.subject.endsWith("resolved"))).toHaveLength(2);
  });

  it("change log, daily: an unlogged ticket change is flushed; admissions are left to their own check", async () => {
    const h = await harness({ clock });
    const { party, os } = await openParty(h);
    const [t] = await testTickets(h, os, 1);
    const door = await seedDoor(party, h.clock);
    // A ticket change whose change-log write never happened, and an admitted ticket (normal: rev > logged_rev).
    await env.DB.prepare("UPDATE tickets SET rev = rev + 1, last_action = 'renamed' WHERE id = ?").bind(t!.id).run();
    const rev = Number(await env.DB.prepare("SELECT rev FROM tickets WHERE id = ?").bind(t!.id).first("rev"));
    const [u] = await testTickets(h, os, 1);
    expect((await scan(h, door, u!.qr)).verdict).toBe("admit");
    await env.DB.prepare("UPDATE health_state SET daily_day = 0 WHERE id = 'main'").run();
    const r = await run();
    expect(r.daily).toBe(true);
    expect(r.checks!.changelog).toBe("ok");
    expect(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM change_log WHERE event_id = ?").bind(`ticket:${t!.id}:${rev}`).first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT logged_rev FROM tickets WHERE id = ?").bind(t!.id).first("logged_rev")).toBe(rev);
  });

  it("admissions: one without its ledger record alerts until the scanner's retry records it", async () => {
    const h = await harness({ clock });
    const { party, os } = await openParty(h);
    const door = await seedDoor(party, h.clock);
    const [a, b] = await testTickets(h, os, 2);
    clock.advance(1);
    expect((await scan(h, door, a!.qr)).verdict).toBe("admit");
    h.ledger.admissionMode = "fail";
    const scanId = newId();
    expect((await scan(h, door, b!.qr, scanId)).verdict).toBe("recording");
    // Too recent: its ledger write may still be in flight.
    clock.advance(60_000);
    let r = await run();
    expect(r.checks!.admissions).toBe("ok");
    expect(r.admissions_checked).toBe(0);

    clock.advance(5 * 60_000);
    r = await run();
    expect(r.checks!.admissions).toBe("problem");
    expect(r.admissions_checked).toBe(2);
    expect(JSON.parse((await check("admissions"))!.detail!)).toEqual({ missing: [b!.id] });
    expect((await alerts()).filter((x) => x.subject.includes("Admissions"))).toHaveLength(2);

    // Still missing on the next run (remembered, re-checked), no second alert within 6 hours.
    clock.advance(15 * 60_000);
    r = await run();
    expect(r.checks!.admissions).toBe("problem");
    expect(await alerts()).toHaveLength(2);

    // The scanner retries with the same scan id: the record is written; the check clears.
    h.ledger.admissionMode = "ok";
    expect((await scan(h, door, b!.qr, scanId)).verdict).toBe("admit");
    clock.advance(15 * 60_000);
    r = await run();
    expect(r.checks!.admissions).toBe("ok");
    expect((await alerts()).filter((x) => x.subject === "Sahra health: Admissions recorded in the ledger resolved")).toHaveLength(2);
  });

  it("admissions: at most 200 per run; the rest are checked by the next run", async () => {
    const h = await harness({ clock });
    const { party, os } = await openParty(h);
    const door = await seedDoor(party, h.clock);
    const tickets = [];
    for (let i = 0; i < 11; i++) tickets.push(...await testTickets(h, os, i < 10 ? 20 : 5));
    for (const t of tickets) {
      expect((await scan(h, door, t.qr)).verdict).toBe("admit");
      clock.advance(10);
    }
    clock.advance(5 * 60_000);
    const r1 = await run();
    expect(r1.admissions_checked).toBe(200);
    expect(r1.checks!.admissions).toBe("ok");
    clock.advance(15 * 60_000);
    const r2 = await run();
    expect(r2.admissions_checked).toBeGreaterThanOrEqual(5);
    expect(r2.admissions_checked).toBeLessThan(10);
    console.error(JSON.stringify({ evt: "measure", what: "health_run_200_admissions_local", main: r1.main, ledger: r1.ledger }));
    expect(r1.main.queries).toBeLessThanOrEqual(9);
    expect(r1.ledger.queries).toBeLessThanOrEqual(3);
  }, 30_000); // creates hundreds of admissions: slower than the 5 s default on a busy machine

  it("outbox: failed, late and stuck emails alert; the check clears when none remain", async () => {
    const p = await seedParty();
    const ins = (status: string, next: number) => env.DB.prepare(`INSERT INTO outbox (id, party_id, kind, to_email, subject, body_text, status, created_at, next_attempt_at)
      VALUES (?, ?, 'ticket_link', 'g@example.com', 's', 'b', ?, ?, ?)`).bind(newId(), p, status, clock.now(), next).run();
    await ins("failed", clock.now() - 3600_000);
    await ins("queued", clock.now() - 2 * 3600_000);
    await ins("sending", clock.now() - 3600_000);
    await ins("queued", clock.now() - 10 * 60_000); // not late yet
    let r = await run({ emailConfigured: false });
    expect(r.checks!.outbox).toBe("problem");
    expect((await check("outbox"))!.summary).toBe("1 email failed in the last 24 hours; 1 waiting to be sent for more than an hour (no email provider is configured); 1 stuck while sending.");
    // (The alerts themselves are queued too; the test has no sender.)
    await env.DB.prepare("UPDATE outbox SET status = 'sent' WHERE status != 'failed'").run();
    clock.advance(25 * 3600_000);
    r = await run();
    expect(r.checks!.outbox).toBe("ok");
    expect((await alerts()).filter((x) => x.subject === "Sahra health: Email outbox resolved")).toHaveLength(2);
  });

  it("database size: past 70% of 500 MB alerts, and clears; real sizes come from D1's own figure", async () => {
    sizes.ledger = 360e6;
    expect((await run()).checks!.db_size).toBe("problem");
    expect((await check("db_size"))!.summary).toBe("Past 70%: ledger 360.0 MB of 500.0 MB.");
    sizes.ledger = 2e6;
    clock.advance(15 * 60_000);
    expect((await run()).checks!.db_size).toBe("ok");
    const real = await dbSizes(env);
    expect(real.main).toBeGreaterThan(0);
    expect(real.ledger).toBeGreaterThan(0);
    expect(real.files).toBeGreaterThan(0);
    expect(await dbSizes({ DB: env.DB, LEDGER: env.LEDGER })).toMatchObject({ files: null });
  });

  it("backup: not set up is shown, not alerted; older than 26 hours alerts; a new backup resolves it", async () => {
    let r = await run();
    expect(r.checks!.backup).toBe("unknown");
    expect(r.alerts).toBe(0);
    // Workstream E writes this column after each successful backup.
    await env.DB.prepare("UPDATE health_state SET last_backup_at = ?, last_backup_note = 'drive' WHERE id = 'main'").bind(clock.now() - 27 * 3600_000).run();
    clock.advance(15 * 60_000);
    r = await run();
    expect(r.checks!.backup).toBe("problem");
    expect(r.alerts).toBe(2);
    await env.DB.prepare("UPDATE health_state SET last_backup_at = ? WHERE id = 'main'").bind(clock.now()).run();
    clock.advance(15 * 60_000);
    r = await run();
    expect(r.checks!.backup).toBe("ok");
    expect(r.alerts).toBe(2);
    expect((await alerts()).map((a) => a.subject)).toEqual(["Sahra health: Backup needs attention", "Sahra health: Backup needs attention",
      "Sahra health: Backup resolved", "Sahra health: Backup resolved"]);
  });

  it("dedup: at most one alert per problem per 6 hours, one resolved message, then silence", async () => {
    sizes.main = 400e6;
    const alerts = async () => (await env.DB.prepare("SELECT subject, body_text FROM outbox WHERE subject LIKE '%Database size%' ORDER BY created_at, to_email").all<{ subject: string; body_text: string }>()).results;
    for (let i = 0; i < 24; i++) { // runs from 0 to 5 h 45 min
      await run();
      clock.advance(15 * 60_000);
    }
    expect(await alerts()).toHaveLength(2);
    await run(); // 6 hours after the first alert
    const sent = await alerts();
    expect(sent).toHaveLength(4);
    expect(sent[2]!.body_text).toMatch(/^Still a problem since 2026-10-01 18:00 UTC/);
    sizes.main = 3e6;
    clock.advance(15 * 60_000);
    await run();
    for (let i = 0; i < 3; i++) {
      clock.advance(15 * 60_000);
      await run();
    }
    expect((await alerts()).map((a) => a.subject).filter((s) => s.endsWith("resolved"))).toHaveLength(2);
    expect(await alerts()).toHaveLength(6);
  });

  it("alerts go to every active site owner only: never party owners, never removed site owners; plain text", async () => {
    const party = await seedParty();
    await seedOwner(party, "party-owner-sub");
    const removed = await seedSiteOwner();
    await env.DB.prepare("UPDATE platform_admins SET disabled_at = 1 WHERE id = ?").bind(removed.id).run();
    sizes.files = 351e6;
    await run();
    const sent = await alerts();
    expect(sent.map((a) => a.to_email).sort()).toEqual(owners.map((o) => o.email).sort());
    for (const a of sent) {
      expect(a).toMatchObject({ party_id: "_platform", kind: "health_alert", status: "queued" });
      expect(a.body_text).not.toMatch(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u);
      expect(a.body_text).toContain(`${ORIGIN}/platform`);
    }
    // The reserved row never shows in the site owner's party list.
    const o = await seedSiteOwner();
    const s = await seedPlatformSession(o.sub, clock);
    const h = await harness({ clock });
    const list = (await (await h.req("/api/platform/parties", papi(s, undefined, "GET"))).json()) as { parties: { id: string }[] };
    expect(list.parties.map((p) => p.id)).not.toContain("_platform");
  });

  it("two runs at once: only one does the work (lease)", async () => {
    const [a, b] = await Promise.all([run(), run()]);
    expect([a.skipped, b.skipped].filter((x) => x === "busy")).toHaveLength(1);
    // A run that died holding the lease is taken over once it expires.
    await env.DB.prepare("UPDATE health_state SET lease_until = ? WHERE id = 'main'").bind(clock.now() + HEALTH.leaseMs).run();
    expect((await run()).skipped).toBe("busy");
    clock.advance(HEALTH.leaseMs + 1);
    expect((await run()).skipped).toBeUndefined();
  });

  it("daily: one summary to each site owner, once a day; old per-party counters are deleted", async () => {
    const p = await seedParty();
    const today = dayOf(clock.now());
    await env.DB.batch([
      env.DB.prepare("INSERT INTO party_usage (party_id, kind, day, n) VALUES (?, 'signup', ?, 5), (?, 'signup', ?, 5)").bind(p, today - 9, p, today),
      env.DB.prepare("UPDATE health_state SET daily_day = ? WHERE id = 'main'").bind(today - 1),
    ]);
    expect((await run()).daily).toBe(true);
    clock.advance(15 * 60_000);
    expect((await run()).daily).toBe(false);
    const sent = (await alerts()).filter((a) => a.kind === "health_summary");
    expect(sent.map((a) => a.to_email).sort()).toEqual(owners.map((o) => o.email).sort());
    expect(sent[0]!.subject).toBe("Sahra daily check: all ok");
    expect(sent[0]!.body_text).toContain("If it stops coming, the checks themselves are not running.");
    expect((await env.DB.prepare("SELECT day FROM party_usage WHERE party_id = ?").bind(p).all()).results).toEqual([{ day: today }]);
  });

  it("nothing runs during MAINTENANCE (no query at all); the cron runs the checks every 15 minutes only", async () => {
    const before = await env.DB.prepare("SELECT * FROM health_state").first();
    const d = deps({ maintenance: true });
    const r = await runHealth(d);
    expect(r.skipped).toBe("maintenance");
    expect(d.main.usage.queries + d.ledger.usage.queries).toBe(0);

    const worker = (await import("../src/index")).default;
    const cron = async (t: number, e: typeof env) => {
      logs = [];
      const ctx = createExecutionContext();
      worker.scheduled(createScheduledController({ scheduledTime: t, cron: "* * * * *" }), e, ctx);
      await waitOnExecutionContext(ctx);
      return logs.some((l) => l.startsWith('{"evt":"health"'));
    };
    const quarter = Date.UTC(2026, 9, 1, 18, 15);
    expect(await cron(quarter, { ...env, MAINTENANCE: "1" })).toBe(false);
    expect(await env.DB.prepare("SELECT * FROM health_state").first()).toEqual(before);
    expect(await cron(quarter + 60_000, env)).toBe(false);
    expect(await cron(quarter, env)).toBe(true);
  });

  it("the site owner page: checks, alerts, usage, limits; read-only; site owners only", async () => {
    sizes.main = 400e6;
    await run();
    const h = await harness({ clock });
    const so = await seedSiteOwner();
    const sess = await seedPlatformSession(so.sub, clock);
    logs = [];
    const res = await h.req("/api/platform/health", papi(sess, undefined, "GET"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checks: { id: string; status: string; title: string }[]; alerts: { subject: string; statuses: Record<string, number> }[]; usage: unknown; limits: unknown; last_run_at: number };
    expect(body.checks.find((c) => c.id === "db_size")).toMatchObject({ status: "problem", title: "Database size" });
    expect(body.alerts[0]).toMatchObject({ subject: "Sahra health: Database size needs attention", statuses: { queued: 2 } });
    expect(body.last_run_at).toBe(clock.now());
    expect(body.limits).toEqual(LIMITS);
    const m = lastReq();
    expect([m.rows_written, m.ledger_rows_written]).toEqual([0, 0]);
    console.error(JSON.stringify({ evt: "measure", what: "platform_health_get_local", queries: m.d1_queries, read: m.rows_read, written: m.rows_written }));
    // Organisers (not site owners) are refused.
    const org = await seedOrganiser();
    expect((await h.req("/api/platform/health", papi(await seedPlatformSession(org.sub, clock), undefined, "GET"))).status).toBe(403);
  });
});

describe("per-party limits", () => {
  it("the cap holds when requests arrive at once (checked inside the counting statement)", async () => {
    const p = await seedParty();
    const d = new D1Driver(env.DB);
    const results = await Promise.all(Array.from({ length: 8 }, () => charge(d, p, "notice", 1, clock.now())));
    expect(results.filter((r) => r === "ok")).toHaveLength(LIMITS.notice.cap);
    expect(results.filter((r) => r === "party_limit")).toHaveLength(8 - LIMITS.notice.cap);
    expect(await env.DB.prepare("SELECT n FROM party_usage WHERE party_id = ? AND kind = 'notice'").bind(p).first("n")).toBe(LIMITS.notice.cap);
    // Bulk costs: 999 + 2 would pass 1,000, so it is refused whole; 1 more fits.
    const rel = await Promise.all([charge(d, p, "release", 999, clock.now())]);
    expect(rel).toEqual(["ok"]);
    expect(await charge(d, p, "release", 2, clock.now())).toBe("party_limit");
    expect(await charge(d, p, "release", 1, clock.now())).toBe("ok");
    // Another party is not affected; the next UTC day starts again.
    expect(await charge(d, await seedParty(), "notice", 1, clock.now())).toBe("ok");
    expect(await charge(d, p, "notice", 1, clock.now() + DAY_MS)).toBe("ok");
  });

  it("routes answer 429 with a clear message; nothing is changed", async () => {
    const h = await harness({ clock });
    const { party, os } = await guestParty(h);
    const day = dayOf(clock.now());
    await env.DB.prepare("INSERT INTO party_usage (party_id, kind, day, n) VALUES (?, 'export', ?, ?), (?, 'signup', ?, ?)")
      .bind(party, day, LIMITS.export.cap, party, day, LIMITS.signup.cap).run();
    const ex = await h.req("/api/tickets/export", api(os, undefined, "GET"));
    expect(ex.status).toBe(429);
    expect(await ex.json()).toEqual({ error: "party_limit", message: `This party has reached today's limit of ${LIMITS.export.cap} export pages. It resets at 00:00 UTC.`, limit: LIMITS.export.cap });
    const su = await signup(h, party);
    expect(su.status).toBe(429);
    expect(su.body.error).toBe("party_limit");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n")).toBe(0);
  });

  it("at 50% of the account's daily writes, non-essential work stops; sign-up and the door go on", async () => {
    const h = await harness({ clock });
    const { party, os } = await openParty(h);
    await env.DB.prepare("UPDATE health_state SET usage_day = ?, usage_base = ? WHERE id = 'main'").bind(dayOf(clock.now()), BUDGET_STOP_AT).run();
    const r = await run();
    expect(r.checks!.usage).toBe("problem");
    expect(r.usage_est).toBeGreaterThanOrEqual(BUDGET_STOP_AT);
    const d = new D1Driver(env.DB);
    expect(await charge(d, party, "notice", 1, clock.now())).toBe("daily_budget");
    expect(await charge(d, party, "outbox_approve", 1, clock.now())).toBe("daily_budget");
    expect(await charge(d, party, "signup", 1, clock.now())).toBe("ok");
    const ex = await h.req("/api/tickets/export", api(os, undefined, "GET"));
    expect(ex.status).toBe(429);
    expect(((await ex.json()) as { error: string }).error).toBe("daily_budget");
    const door = await seedDoor(party, h.clock);
    const [t] = await testTickets(h, os, 1);
    expect((await scan(h, door, t!.qr)).verdict).toBe("admit");
    // The next UTC day starts from zero.
    clock.advance(DAY_MS);
    expect((await run()).checks!.usage).toBe("ok");
    expect(await charge(d, party, "notice", 1, clock.now())).toBe("ok");
  });

  it("the estimate counts audit rows, new outbox rows, admissions and emails sent", async () => {
    const h = await harness({ clock });
    const { party, os } = await openParty(h);
    await run(); // sets the cursors
    const base = Number(await env.DB.prepare("SELECT usage_base FROM health_state WHERE id = 'main'").first("usage_base"));
    const door = await seedDoor(party, h.clock);
    const tickets = await testTickets(h, os, 3);
    clock.advance(1);
    for (const t of tickets) expect((await scan(h, door, t.qr)).verdict).toBe("admit");
    const audits = Number(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE id > (SELECT audit_seen_id FROM health_state)").first("n"));
    clock.advance(15 * 60_000);
    const r = await run();
    const w = HEALTH.weights;
    const own = Number(await env.DB.prepare("SELECT usage_base FROM health_state WHERE id = 'main'").first("usage_base")) - base - audits * w.audit - 3 * w.admission;
    expect(r.admissions_checked).toBe(3);
    // What is left is the run's own writes plus its margin of 10.
    expect(own).toBeGreaterThanOrEqual(10);
    expect(own).toBeLessThan(40);
  });

  it("the scan path is unchanged: an admission writes 2 main rows + 1 ledger row and no counter", async () => {
    const h = await harness({ clock });
    const { party, os } = await openParty(h);
    const door = await seedDoor(party, h.clock);
    const [t] = await testTickets(h, os, 1);
    logs = [];
    expect((await scan(h, door, t!.qr)).verdict).toBe("admit");
    const m = lastReq();
    expect([m.rows_written, m.ledger_rows_written]).toEqual([2, 1]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM party_usage WHERE party_id = ?").bind(party).first("n")).toBe(0);
  });
});

// ------------------------------------------------------------------ Discord

/** Stands in for Discord's webhook endpoint. */
class FakeDiscord {
  posts: { url: string; body: { content: string; allowed_mentions: unknown } }[] = [];
  /** Answers in order; when empty, 204. */
  answers: (number | { status: 429; retry_after: number } | "network")[] = [];
  fetch = async (url: string, init?: RequestInit) => {
    const a = this.answers.shift() ?? 204;
    if (a === "network") throw new TypeError("network down");
    this.posts.push({ url, body: JSON.parse(String(init?.body)) });
    if (typeof a === "object") return Response.json({ message: "You are being rate limited.", retry_after: a.retry_after, global: false }, { status: 429 });
    return new Response(a === 204 ? null : "error", { status: a });
  };
}
const HOOK = "https://discord.com/api/webhooks/123456/test-only-token";

describe("Discord (extra channel for health messages)", () => {
  let dc: FakeDiscord;
  beforeEach(async () => {
    dc = new FakeDiscord();
    await env.DB.prepare("DELETE FROM health_discord").run();
  });
  const drun = (over: Partial<HealthDeps> = {}) => run({ discordUrl: HOOK, fetch: dc.fetch, ...over });
  const rows = async () => (await env.DB.prepare("SELECT id, status, attempts, last_error, content FROM health_discord ORDER BY created_at, id").all<{
    id: string; status: string; attempts: number; last_error: string | null; content: string }>()).results;

  it("posts an alert and its resolved message, plain text, no mentions, UTC and Cairo time; same 6-hour rule as email", async () => {
    sizes.main = 400e6;
    const r = await drun();
    expect(r.discord).toEqual({ sent: 1, retry: 0, gave_up: 0 });
    expect(dc.posts).toHaveLength(1);
    const p = dc.posts[0]!;
    expect(p.url).toBe(HOOK);
    expect(p.body.allowed_mentions).toEqual({ parse: [] });
    expect(p.body.content).toBe(`Sahra health: PROBLEM - Database size\nPast 70%: main 400.0 MB of 500.0 MB.\n2026-10-01 18:00 UTC / 2026-10-01 21:00 Cairo\n${ORIGIN}/platform`);
    for (let i = 0; i < 4; i++) { clock.advance(15 * 60_000); await drun(); }
    const sizePosts = () => dc.posts.map((x) => x.body.content.split("\n")[0]).filter((x) => x!.includes("Database size"));
    expect(sizePosts()).toHaveLength(1);
    sizes.main = 2e6;
    clock.advance(15 * 60_000);
    await drun();
    expect(sizePosts()).toEqual(["Sahra health: PROBLEM - Database size", "Sahra health: resolved - Database size"]);
    expect((await rows()).every((x) => x.status === "sent")).toBe(true);
  });

  it("a 5xx or network failure stays pending and is posted by the next run", async () => {
    sizes.main = 400e6;
    dc.answers = [503];
    expect((await drun()).discord).toEqual({ sent: 0, retry: 1, gave_up: 0 });
    expect(await rows()).toMatchObject([{ status: "pending", attempts: 1, last_error: "HTTP 503" }]);
    dc.answers = ["network"];
    clock.advance(15 * 60_000);
    expect((await drun()).discord).toEqual({ sent: 0, retry: 1, gave_up: 0 });
    expect((await rows())[0]!.last_error).toBe("network error: TypeError");
    clock.advance(15 * 60_000);
    expect((await drun()).discord).toEqual({ sent: 1, retry: 0, gave_up: 0 });
    expect(await rows()).toMatchObject([{ status: "sent", attempts: 3, last_error: null }]);
  });

  it("a 429 waits for retry_after; a message still failing after 24 hours is given up and recorded", async () => {
    sizes.main = 400e6;
    dc.answers = [{ status: 429, retry_after: 3600 }];
    await drun();
    clock.advance(15 * 60_000);
    await drun(); // not due yet: no post
    expect(dc.posts).toHaveLength(1);
    clock.advance(46 * 60_000);
    await drun();
    expect(dc.posts.filter((x) => x.body.content.includes("Database size"))).toHaveLength(2);
    expect((await rows())[0]!.status).toBe("sent");

    // Still failing 24 hours after it was created: given up and recorded; a younger one stays pending.
    await env.DB.prepare("DELETE FROM health_discord").run();
    const add = (id: string, at: number) => env.DB.prepare("INSERT INTO health_discord (id, created_at, content, status, next_attempt_at) VALUES (?, ?, 'x', 'pending', ?)").bind(id, at, at).run();
    await add("old", clock.now() - 24 * 3600_000 + 30_000);
    await add("young", clock.now() - 3600_000);
    dc.answers = [500, 500];
    sizes.main = 2e6;
    clock.advance(15 * 60_000);
    const r = await drun();
    expect(r.discord).toMatchObject({ gave_up: 1, retry: 1 });
    expect((await rows()).filter((x) => x.id === "old" || x.id === "young").map((x) => [x.id, x.status, x.last_error])).toEqual([["old", "gave_up", "HTTP 500"], ["young", "pending", "HTTP 500"]]);
  });

  it("a 4xx other than 429 (webhook deleted) gives up at once", async () => {
    sizes.main = 400e6;
    dc.answers = [404];
    expect((await drun()).discord).toEqual({ sent: 0, retry: 0, gave_up: 1 });
    expect(await rows()).toMatchObject([{ status: "gave_up", last_error: "HTTP 404" }]);
  });

  it("at most 3 posts per run; bounded queries", async () => {
    for (let i = 0; i < 5; i++) {
      await env.DB.prepare("INSERT INTO health_discord (id, created_at, content, status, next_attempt_at) VALUES (?, ?, 'x', 'pending', ?)").bind(`t${i}`, clock.now() + i, clock.now()).run();
    }
    const r = await drun();
    expect(r.discord).toEqual({ sent: 3, retry: 0, gave_up: 0 });
    console.error(JSON.stringify({ evt: "measure", what: "health_run_discord_3_posts_local", main: r.main, ledger: r.ledger }));
    clock.advance(15 * 60_000);
    const r2 = await drun();
    expect(r2.discord).toEqual({ sent: 2, retry: 0, gave_up: 0 });
    clock.advance(15 * 60_000);
    const r3 = await drun();
    expect(r3.discord).toEqual({ sent: 0, retry: 0, gave_up: 0 });
    console.error(JSON.stringify({ evt: "measure", what: "health_run_discord_idle_local", main: r3.main, ledger: r3.ledger }));
    expect(r3.main.queries).toBeLessThanOrEqual(7);
  });

  it("the daily summary is posted once", async () => {
    await env.DB.prepare("UPDATE health_state SET daily_day = 0 WHERE id = 'main'").run();
    await drun();
    clock.advance(15 * 60_000);
    await drun();
    expect(dc.posts).toHaveLength(1);
    expect(dc.posts[0]!.body.content).toMatch(/^Sahra daily check: all ok\n2026-10-01 18:00 UTC \/ 2026-10-01 21:00 Cairo\n- Change log/);
  });

  it("a URL that is not a Discord webhook is ignored and shown as not used; MAINTENANCE posts nothing", async () => {
    sizes.main = 400e6;
    for (const url of ["https://evil.example/api/webhooks/1/x", "http://discord.com/api/webhooks/1/x", "https://discord.com.evil.example/api/webhooks/1/x", "https://discord.com/api/webhooks/1/x?wait=1#"]) {
      const r = await drun({ discordUrl: url });
      expect(r.discord, url).toBe("not_configured");
    }
    expect(dc.posts).toHaveLength(0);
    expect(await rows()).toEqual([]);
    expect((await drun({ maintenance: true })).skipped).toBe("maintenance");
    expect(dc.posts).toHaveLength(0);
    expect(discordStatus("https://discordapp.com/api/webhooks/1/abc_-")).toBe("configured");
    expect(discordStatus(undefined)).toBe("not_set");

    const h = await harness({ clock, env: { DISCORD_WEBHOOK_URL: "https://evil.example/hook" } as never });
    const so = await seedSiteOwner();
    const res = await h.req("/api/platform/health", papi(await seedPlatformSession(so.sub, clock), undefined, "GET"));
    const text = await res.text();
    expect(JSON.parse(text).discord.status).toBe("invalid");
    expect(text).not.toContain("evil.example");
  });

  it("text for Discord: no emojis, no mass mentions, at most 1,900 characters", () => {
    const t = discordText(`@everyone party \u{1F389} @here ${"x".repeat(3000)}`);
    expect(t.length).toBeLessThanOrEqual(1900);
    expect(t).not.toMatch(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}]/u);
    expect(t).not.toMatch(/@(everyone|here)/);
    expect(t.endsWith("...")).toBe(true);
  });
});
