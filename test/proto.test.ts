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
