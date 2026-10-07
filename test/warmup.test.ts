// The startup warm-up (src/warmup.ts) runs the scan and join code paths against
// an in-memory stand-in. It must never touch the real databases, must not be
// counted as requests, and must keep working when random values are forbidden
// (as they are in a Worker's global scope).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetRequestCounters } from "../src/app";
import { Db } from "../src/db";
import { TicketDb } from "../src/db/tickets";
import { D1Ledger } from "../src/ledger";
import { warmUp } from "../src/warmup";
import { harness } from "./helpers";

afterEach(() => vi.restoreAllMocks());

async function counts() {
  const out: Record<string, unknown> = {};
  for (const t of ["parties", "staff", "invites", "sessions", "audit", "tickets", "scans"]) {
    out[t] = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first("n");
  }
  for (const t of ["change_log", "party_control"]) out[t] = await env.LEDGER.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first("n");
  return out;
}

describe("startup warm-up", () => {
  for (const restricted of [false, true]) {
    it(`runs the scan and join paths without touching the databases${restricted ? " (random values forbidden, as at startup)" : ""}`, async () => {
      const h = await harness();
      const before = await counts();
      const redeem = vi.spyOn(TicketDb.prototype, "redeem");
      const record = vi.spyOn(D1Ledger.prototype, "recordAdmission");
      const consume = vi.spyOn(Db.prototype, "consumeDoorInvite");
      if (restricted) {
        vi.spyOn(crypto, "randomUUID").mockImplementation(() => { throw new Error("Disallowed operation called within global scope"); });
        vi.spyOn(crypto, "getRandomValues").mockImplementation(() => { throw new Error("Disallowed operation called within global scope"); });
      }
      let done = 0;
      await warmUp(h.app, () => { done++; });
      vi.restoreAllMocks();
      expect(done).toBe(1);
      // Through the app (unrestricted) and directly (always): each path ran to its database calls.
      expect(redeem.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(record.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(consume.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(await counts()).toEqual(before);
    });
  }

  it("is not counted: the first real request after it is the isolate's first", async () => {
    const h = await harness();
    await warmUp(h.app, resetRequestCounters);
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m: unknown) => { lines.push(String(m)); });
    await h.req("/api/me");
    const req = lines.map((l) => JSON.parse(l)).find((l) => l.evt === "req");
    expect(req.iso_req).toBe(1);
    expect(req.route_req).toBe(1);
    expect(req.in_flight).toBe(1);
  });
});
