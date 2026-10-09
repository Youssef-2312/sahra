// The outbox sender (cron run): claiming, results, backoff, reclaim, caps,
// provider order, approval, content checks. Fake SMTP server and fake Brevo.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { D1Driver } from "../src/db/driver";
import { sql } from "../src/db/sql";
import { EMAIL, runSender, type SenderDeps } from "../src/email/sender";
import { newId } from "../src/lib/crypto";
import { outboxInsert } from "../src/outbox";
import { FakeBrevo, FakeSmtp } from "./fake-smtp";
import { Clock, seedParty } from "./helpers";

// Test-only settings; real ones are set by the owner (docs/DECISIONS.md, Workstream D).
const GMAIL = { GMAIL_ADDRESS: "platform@gmail.com", GMAIL_APP_PASSWORD: "test-only-app-password" };
const BREVO = { BREVO_API_KEY: "test-only-brevo-key", BREVO_SENDER: "platform@example.com" };

let clock: Clock, smtp: FakeSmtp, brevo: FakeBrevo, party: string;
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM outbox"), env.DB.prepare("DELETE FROM email_quota")]);
  clock = new Clock();
  smtp = new FakeSmtp();
  brevo = new FakeBrevo();
  party = await seedParty();
});

const deps = (): SenderDeps => ({ now: clock.now, random: () => 0.5, connect: smtp.connect, fetch: brevo.fetch });
const run = (vars: Record<string, string> = GMAIL, driver = new D1Driver(env.DB)) => runSender({ ...env, ...vars }, driver, deps());

async function add(n = 1, opts: { needsApproval?: boolean; body?: string; to?: string } = {}) {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = newId();
    ids.push(id);
    await new D1Driver(env.DB).batch([outboxInsert({
      id, partyId: party, kind: "ticket_link", toEmail: opts.to ?? `guest${i}@example.com`, subject: "Your ticket",
      bodyText: opts.body ?? "Your ticket: https://sahra.test/t/x", now: clock.now(), createdBy: null, needsApproval: !!opts.needsApproval,
    }, sql`1`)]);
    clock.advance(1);
  }
  return ids;
}

async function row(id: string) {
  return env.DB.prepare("SELECT status, attempts, next_attempt_at, provider, last_error, claim_op, sent_at FROM outbox WHERE id = ?").bind(id)
    .first<{ status: string; attempts: number; next_attempt_at: number | null; provider: string | null; last_error: string | null; claim_op: string | null; sent_at: number | null }>();
}

const sentIds = (s: FakeSmtp) => s.messages.map((m) => /Message-ID: <([^@]+)@/.exec(m.data)![1]);

describe("email sender", () => {
  it("no provider configured: nothing is read, claimed or sent", async () => {
    const [id] = await add(1);
    const d = new D1Driver(env.DB);
    const r = await run({}, d);
    expect(r.skipped).toBe("no_provider");
    expect(d.usage.queries).toBe(0);
    expect(smtp.connections + brevo.requests.length).toBe(0);
    expect(await row(id!)).toMatchObject({ status: "queued", attempts: 0 });
    // Half a configuration is no configuration.
    expect((await run({ GMAIL_ADDRESS: "platform@gmail.com", BREVO_SENDER: "x@example.com" })).skipped).toBe("no_provider");
  });

  it("the Worker's scheduled handler runs the sender (no provider in the test environment: nothing sent)", async () => {
    const [id] = await add(1);
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
    const worker = (await import("../src/index")).default;
    const ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime: clock.now(), cron: "* * * * *" }), env, ctx);
    await waitOnExecutionContext(ctx);
    spy.mockRestore();
    const line = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((l) => l?.evt === "email_run");
    expect(line).toMatchObject({ skipped: "no_provider", d1_queries: 0, rows_written: 0 });
    expect(await row(id!)).toMatchObject({ status: "queued", attempts: 0 });
  });

  it("nothing due: one cheap read, no writes", async () => {
    await add(1, { needsApproval: true });
    const d = new D1Driver(env.DB);
    expect((await run(GMAIL, d)).skipped).toBe("nothing_due");
    expect(d.usage).toMatchObject({ queries: 1, rows_written: 0 });
    // Index outbox_due, two status ranges: measured 4 rows read on an empty outbox.
    expect(d.usage.rows_read).toBeLessThanOrEqual(4);
  });

  it("sends a due row through Gmail and records it (rows per email measured)", async () => {
    const ids = await add(3);
    const d = new D1Driver(env.DB);
    const r = await run(GMAIL, d);
    expect(r).toMatchObject({ claimed: 3, sent: 3 });
    for (const id of ids) expect(await row(id)).toMatchObject({ status: "sent", attempts: 1, provider: "gmail", last_error: null });
    expect(smtp.connections).toBe(1);
    expect(sentIds(smtp).sort()).toEqual([...ids].sort());
    const one = await add(1);
    const d1 = new D1Driver(env.DB);
    await run(GMAIL, d1);
    expect(await row(one[0]!)).toMatchObject({ status: "sent" });
    // Measured locally: 1 email 4 queries / 24 read / 5 written; 3 emails 6 / 38 / 15.
    // Per email: claim (row + outbox_due entry), result (row + entry), hour counter.
    expect(d1.usage.rows_written).toBeLessThanOrEqual(5);
    expect(d.usage.rows_written).toBeLessThanOrEqual(15);
    expect(d.usage.queries).toBe(6);
    // A second run finds nothing due.
    expect((await run()).skipped).toBe("nothing_due");
  });

  it("two overlapping runs never send one row twice", async () => {
    const ids = await add(5);
    smtp.delayMs = 5; // replies are slow, so the two runs interleave
    const [a, b] = await Promise.all([run(), run()]);
    expect(a.claimed + b.claimed).toBe(5);
    expect(a.sent + b.sent).toBe(5);
    const s = sentIds(smtp);
    expect(new Set(s).size).toBe(s.length);
    expect([...s].sort()).toEqual([...ids].sort());
  });

  it("a run that started first keeps its claim while another run runs", async () => {
    const ids = await add(4);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const slow = new FakeSmtp();
    const slowConnect = slow.connect;
    // Run A's SMTP server waits for the gate before greeting.
    const runA = runSender({ ...env, ...GMAIL }, new D1Driver(env.DB), {
      ...deps(), connect: (h, p) => { const s = slowConnect(h, p); const r = s.readable; return { ...s, readable: r.pipeThrough(new TransformStream({ async transform(c, ctl) { await gate; ctl.enqueue(c); } })) }; },
    });
    await new Promise((r) => setTimeout(r, 30));
    const b = await run();
    release();
    const a = await runA;
    expect(a.claimed).toBe(3);
    expect(b.claimed).toBe(1);
    const all = [...sentIds(slow), ...sentIds(smtp)];
    expect(all.sort()).toEqual([...ids].sort());
  });

  it("unknown result: backoff with jitter, no fallback, retried later", async () => {
    const [id] = await add(1);
    smtp.dataEnd = (n) => (n === 1 ? "drop" : "ok");
    const r = await run({ ...GMAIL, ...BREVO });
    expect(r).toMatchObject({ claimed: 1, retry: 1, sent: 0 });
    expect(brevo.requests.length).toBe(0);
    const after = (await row(id!))!;
    expect(after).toMatchObject({ status: "queued", attempts: 1, provider: "gmail" });
    expect(after.last_error).toMatch(/closed/);
    // random 0.5 -> 0.75 x the base 2 minutes
    expect(after.next_attempt_at).toBe(clock.now() + 90_000);
    expect((await run()).skipped).toBe("nothing_due");
    clock.advance(90_000);
    expect(await run()).toMatchObject({ sent: 1 });
    expect(await row(id!)).toMatchObject({ status: "sent", attempts: 2 });
  });

  it("backoff grows exponentially with jitter, up to the maximum", async () => {
    const { backoffMs } = await import("../src/email/sender");
    expect(backoffMs(1, 0)).toBe(60_000);
    expect(backoffMs(1, 1)).toBe(120_000);
    expect(backoffMs(3, 1)).toBe(480_000);
    expect(backoffMs(20, 1)).toBe(EMAIL.backoffMaxMs);
  });

  it("a row stuck in 'sending' past the claim timeout is reclaimed; one within it is left alone", async () => {
    const [stuck, fresh] = await add(2);
    await env.DB.batch([
      env.DB.prepare("UPDATE outbox SET status = 'sending', claim_op = 'old-run', attempts = 1, next_attempt_at = ? WHERE id = ?").bind(clock.now() - 1, stuck),
      env.DB.prepare("UPDATE outbox SET status = 'sending', claim_op = 'live-run', attempts = 1, next_attempt_at = ? WHERE id = ?").bind(clock.now() + 60_000, fresh),
    ]);
    expect(await run()).toMatchObject({ claimed: 1, sent: 1 });
    expect(await row(stuck!)).toMatchObject({ status: "sent", attempts: 2 });
    expect(await row(fresh!)).toMatchObject({ status: "sending", claim_op: "live-run" });
    // The old run finishing late cannot overwrite the new result (its claim_op is gone).
    await env.DB.prepare("UPDATE outbox SET status = 'queued' WHERE id = ? AND claim_op = 'old-run' AND status = 'sending'").bind(stuck).run();
    expect(await row(stuck!)).toMatchObject({ status: "sent" });
  });

  it("retry limit: failed with the last error", async () => {
    const [id] = await add(1);
    smtp.dataEnd = () => "drop";
    for (let i = 1; i <= EMAIL.maxAttempts; i++) {
      const r = await run();
      expect(r.claimed, `attempt ${i}`).toBe(1);
      clock.advance(EMAIL.backoffMaxMs);
    }
    const after = (await row(id!))!;
    expect(after).toMatchObject({ status: "failed", attempts: EMAIL.maxAttempts });
    expect(after.last_error).toMatch(/closed/);
    expect((await run()).skipped).toBe("nothing_due");
    // A row stuck in "sending" on its last attempt is failed, not retried.
    const [last] = await add(1);
    await env.DB.prepare("UPDATE outbox SET status = 'sending', attempts = ?, next_attempt_at = ? WHERE id = ?").bind(EMAIL.maxAttempts, clock.now() - 1, last).run();
    expect(await run()).toMatchObject({ gaveUp: 1, claimed: 0 });
    expect(await row(last!)).toMatchObject({ status: "failed", last_error: expect.stringMatching(/unknown/) });
  });

  it("Gmail first; Brevo when Gmail definitely did not take it; Gmail not retried in the same run", async () => {
    const ids = await add(2);
    smtp.authOk = false;
    const r = await run({ ...GMAIL, ...BREVO });
    expect(r).toMatchObject({ sent: 2 });
    expect(smtp.connections).toBe(1);
    expect(brevo.requests.length).toBe(2);
    for (const id of ids) expect(await row(id)).toMatchObject({ status: "sent", provider: "brevo" });
    const req = brevo.requests[0]!;
    expect(req.url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(req.headers.get("api-key")).toBe(BREVO.BREVO_API_KEY);
    expect(req.body).toMatchObject({ sender: { email: BREVO.BREVO_SENDER, name: "Sahra" }, subject: "Your ticket", textContent: expect.any(String) });
    expect(req.body.htmlContent).toBeUndefined();
    const errs = await env.DB.prepare("SELECT last_error FROM outbox").all();
    expect(JSON.stringify(errs.results)).not.toContain(GMAIL.GMAIL_APP_PASSWORD);
  });

  it("daily caps (rolling 24 hours): Gmail at its cap -> Brevo; both at cap -> nothing claimed", async () => {
    const hour = Math.floor(clock.now() / 3600_000);
    await env.DB.prepare("INSERT INTO email_quota (provider, hour, sent) VALUES ('gmail', ?, ?), ('gmail', ?, 1000)")
      .bind(hour - 3, EMAIL.dayCap.gmail, hour - 24).run();
    const [a] = await add(1);
    expect(await run({ ...GMAIL, ...BREVO })).toMatchObject({ sent: 1 });
    expect(smtp.connections).toBe(0);
    expect(await row(a!)).toMatchObject({ provider: "brevo" });
    await env.DB.prepare("INSERT INTO email_quota (provider, hour, sent) VALUES ('brevo', ?, ?) ON CONFLICT DO UPDATE SET sent = excluded.sent")
      .bind(hour, EMAIL.dayCap.brevo).run();
    const [b] = await add(1);
    expect((await run({ ...GMAIL, ...BREVO })).skipped).toBe("at_cap");
    expect(await row(b!)).toMatchObject({ status: "queued", attempts: 0 });
    // Gmail's sends 24+ hours ago no longer count.
    clock.advance(21 * 3600_000 + 1);
    expect(await run(GMAIL)).toMatchObject({ sent: 1 });
  });

  it("per-minute cap and counting", async () => {
    await add(EMAIL.minuteCap.gmail + 2);
    let sent = 0;
    for (let i = 0; i < 6; i++) sent += (await run()).sent;
    expect(sent).toBe(EMAIL.minuteCap.gmail);
    clock.advance(60_000);
    expect(await run()).toMatchObject({ sent: 2 });
    const q = await env.DB.prepare("SELECT SUM(sent) AS n FROM email_quota WHERE provider = 'gmail'").first("n");
    expect(q).toBe(EMAIL.minuteCap.gmail + 2);
  });

  it("Gmail's own daily-limit reply fills its cap, so later runs go straight to Brevo", async () => {
    await add(2);
    smtp.mailReply = "550 5.4.5 Daily user sending limit exceeded";
    expect(await run({ ...GMAIL, ...BREVO })).toMatchObject({ sent: 2 });
    await add(1);
    clock.advance(3600_000);
    expect(await run({ ...GMAIL, ...BREVO })).toMatchObject({ sent: 1 });
    expect(smtp.connections).toBe(1);
    expect(brevo.requests.length).toBe(3);
  });

  it("Brevo errors: 429 retry later, 400 failed, 500 unknown, network error unknown", async () => {
    const cases: [Response | "throw", string][] = [
      [Response.json({ code: "too_many_requests" }, { status: 429 }), "queued"],
      [Response.json({ code: "invalid_parameter", message: "email is not valid" }, { status: 400 }), "failed"],
      [new Response("oops", { status: 500 }), "queued"],
      ["throw", "queued"],
    ];
    for (const [reply, status] of cases) {
      await env.DB.prepare("DELETE FROM outbox").run();
      const [id] = await add(1);
      brevo.reply = () => reply;
      await run(BREVO);
      const r = (await row(id!))!;
      expect(r.status, String(reply)).toBe(status);
      expect(r.last_error).not.toContain(BREVO.BREVO_API_KEY);
    }
  });

  it("rows awaiting approval are never sent; once approved they are", async () => {
    const [id] = await add(1, { needsApproval: true });
    expect((await run()).skipped).toBe("nothing_due");
    clock.advance(3 * 24 * 3600_000);
    expect((await run()).skipped).toBe("nothing_due");
    expect(await row(id!)).toMatchObject({ status: "awaiting_approval", attempts: 0 });
    await env.DB.prepare("UPDATE outbox SET status = 'queued', approved_at = ?, next_attempt_at = ? WHERE id = ?").bind(clock.now(), clock.now(), id).run();
    expect(await run()).toMatchObject({ sent: 1 });
    const cancelled = (await add(1))[0]!;
    await env.DB.prepare("UPDATE outbox SET status = 'cancelled', next_attempt_at = NULL WHERE id = ?").bind(cancelled).run();
    expect((await run()).skipped).toBe("nothing_due");
  });

  it("refuses emojis and unsafe addresses that reached the table without the producer's check", async () => {
    const [id] = await add(1);
    await env.DB.prepare("UPDATE outbox SET body_text = ? WHERE id = ?").bind("Party time \u{1F389}", id).run();
    const [bad] = await add(1);
    await env.DB.prepare("UPDATE outbox SET to_email = ? WHERE id = ?").bind("x@example.com>\r\nRCPT TO:<y@example.com", bad).run();
    expect(await run()).toMatchObject({ failed: 2, sent: 0 });
    expect(await row(id!)).toMatchObject({ status: "failed", last_error: "emails must not contain emojis" });
    expect(await row(bad!)).toMatchObject({ status: "failed", last_error: "invalid recipient address" });
    expect(smtp.messages.length).toBe(0);
  });

  it("adding a row costs (measured)", async () => {
    const d = new D1Driver(env.DB);
    await d.batch([outboxInsert({
      id: newId(), partyId: party, kind: "ticket_link", toEmail: "a@example.com", subject: "s", bodyText: "b", now: 1, createdBy: null, needsApproval: false,
    }, sql`1`)]);
    // The row plus its two index entries (outbox_due, outbox_party).
    expect(d.usage.rows_written).toBe(3);
  });

  it("refuses an emoji subject at the producer too", () => {
    expect(() => outboxInsert({
      id: newId(), partyId: party, kind: "party_notice", toEmail: "a@example.com", subject: "Tonight \u{2728}", bodyText: "x",
      now: 1, createdBy: null, needsApproval: true,
    }, sql`1`)).toThrow(/emojis/);
  });
});
