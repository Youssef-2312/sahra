// Checkpoint A prototype of the scan path (replaced in Phase 2).
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId, newToken } from "../src/lib/crypto";
import { api, harness, seedOwner, seedParty, seedSession } from "./helpers";

describe("scan prototype", () => {
  it("admits once; a retry returns the stored outcome; a second scan id says used; bad signature stops", async () => {
    const h = await harness();
    const party = await seedParty();
    const o = await seedOwner(party);
    const os = await seedSession(party, o.id, "owner", h.clock);
    const { qr } = (await (await h.req("/api/proto/ticket", api(os, {}))).json()) as { qr: string };
    expect(qr).toMatch(/^S1\.[A-Z0-9-]+\.1[0-9A-Z]{16}\.1\.[0-9A-Z]{26}$/);

    const scanId = newId();
    const first = await (await h.req("/api/proto/scan", api(os, { scan_id: scanId, qr }))).json();
    expect(first).toMatchObject({ verdict: "admit" });
    expect(await (await h.req("/api/proto/scan", api(os, { scan_id: scanId, qr }))).json()).toMatchObject({ verdict: "admit" });
    expect(await (await h.req("/api/proto/scan", api(os, { scan_id: newId(), qr }))).json()).toMatchObject({ verdict: "used" });

    const bad = qr.slice(0, -1) + (qr.endsWith("0") ? "1" : "0");
    expect(await (await h.req("/api/proto/scan", api(os, { scan_id: newId(), qr: bad }))).json()).toEqual({ verdict: "stop", reason: "invalid code" });
  });

  it("parallel scans of one ticket from several phones: exactly one admit", async () => {
    const h = await harness();
    const party = await seedParty();
    const o = await seedOwner(party);
    const os = await seedSession(party, o.id, "owner", h.clock);
    const phones = await Promise.all(Array.from({ length: 6 }, () => seedSession(party, o.id, "owner", h.clock)));
    const { qr } = (await (await h.req("/api/proto/ticket", api(os, {}))).json()) as { qr: string };
    const rs = await Promise.all(phones.map((p) => h.req("/api/proto/scan", api(p, { scan_id: newId(), qr })).then((r) => r.json())));
    expect(rs.filter((r) => (r as { verdict: string }).verdict === "admit").length).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM proto_scans WHERE outcome = 'pending'").first("n")).toBe(0);
  });

  it("reports rows written per admitted scan", async () => {
    const h = await harness();
    const party = await seedParty();
    const o = await seedOwner(party);
    const os = await seedSession(party, o.id, "owner", h.clock);
    const { qr } = (await (await h.req("/api/proto/ticket", api(os, {}))).json()) as { qr: string };
    const r = (await (await h.req("/api/proto/scan", api(os, { scan_id: newId(), qr }))).json()) as { rows_written: number };
    console.log(JSON.stringify({ evt: "measure", what: "proto_scan_rows_written_local", value: r.rows_written }));
    expect(r.rows_written).toBeGreaterThan(0);
    void newToken;
  });
});

describe("scan rate limit", () => {
  /** Fake limiter: `limit` calls per key per window, recording the keys it saw. */
  function fakeLimiter(limit: number, fail = false) {
    const counts = new Map<string, number>();
    return {
      keys: counts,
      async limit({ key }: { key: string }) {
        if (fail) throw new Error("limiter unavailable");
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { success: counts.get(key)! <= limit };
      },
    };
  }

  it("is keyed per scanner session, not per IP: phones on one Wi-Fi each get their own budget", async () => {
    const rl = fakeLimiter(3);
    const h = await harness({ env: { RL_SCAN: rl as unknown as RateLimit } });
    const party = await seedParty();
    const o = await seedOwner(party);
    const a = await seedSession(party, o.id, "owner", h.clock);
    const b = await seedSession(party, o.id, "owner", h.clock);
    const { qr } = (await (await h.req("/api/proto/ticket", api(a, {}))).json()) as { qr: string };
    const sameIp = (s: typeof a) => {
      const init = api(s, { scan_id: newId(), qr });
      (init.headers as Record<string, string>)["cf-connecting-ip"] = "203.0.113.7";
      return h.req("/api/proto/scan", init).then((r) => r.json() as Promise<{ verdict: string; reason?: string }>);
    };
    for (let i = 0; i < 3; i++) expect((await sameIp(a)).reason).not.toBe("rate_limited");
    expect(await sameIp(a)).toEqual({ verdict: "cant_verify", reason: "rate_limited" });
    // Same IP, different phone (session): not affected by the first phone's budget.
    expect((await sameIp(b)).reason).not.toBe("rate_limited");
    expect([...rl.keys.keys()].every((k) => k.startsWith("scan:") && !k.includes("203.0.113.7"))).toBe(true);
    expect(rl.keys.size).toBe(2);
  });

  it("a limiter outage does not stop the door (the database still decides)", async () => {
    const h = await harness({ env: { RL_SCAN: fakeLimiter(0, true) as unknown as RateLimit } });
    const party = await seedParty();
    const o = await seedOwner(party);
    const s = await seedSession(party, o.id, "owner", h.clock);
    const { qr } = (await (await h.req("/api/proto/ticket", api(s, {}))).json()) as { qr: string };
    expect(await (await h.req("/api/proto/scan", api(s, { scan_id: newId(), qr }))).json()).toMatchObject({ verdict: "admit" });
    expect(await (await h.req("/api/proto/scan", api(s, { scan_id: newId(), qr }))).json()).toMatchObject({ verdict: "used" });
  });

  it("a missing limiter binding blocks (misconfiguration fails closed)", async () => {
    const h = await harness({ env: { RL_SCAN: undefined } });
    const party = await seedParty();
    const o = await seedOwner(party);
    const s = await seedSession(party, o.id, "owner", h.clock);
    const { qr } = (await (await h.req("/api/proto/ticket", api(s, {}))).json()) as { qr: string };
    expect(await (await h.req("/api/proto/scan", api(s, { scan_id: newId(), qr }))).json()).toEqual({ verdict: "cant_verify", reason: "rate_limited" });
  });
});
