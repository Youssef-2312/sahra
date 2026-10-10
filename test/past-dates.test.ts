// A party's start, end and close of requests can not be set in the past (owner: a
// date picked a year back was accepted). Only a changed value is checked: during
// the party (start already past) other details still save, and so does the same start.
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { api, guestParty, harness } from "./helpers";

vi.spyOn(console, "log").mockImplementation(() => {});

describe("dates in the past", () => {
  it("refuses a changed start, end or close of requests in the past; the saved past start does not block other edits", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const now = h.clock.now();
    const edit = (b: Record<string, unknown>) => h.req("/api/party/details", api(os, b));
    const yearAgo = now - 365 * 86_400_000;
    for (const f of ["starts_at", "ends_at", "registration_closes_at"]) {
      const r = await edit({ [f]: yearAgo });
      expect(r.status, f).toBe(400);
      expect(await r.json()).toEqual({ error: `in_the_past:${f}` });
    }
    // In the future: fine.
    expect((await edit({ starts_at: now + 86_400_000, ends_at: now + 90_000_000 })).status).toBe(200);
    // The party is on now (start already past): the same start and other edits still save.
    await env.DB.prepare("UPDATE parties SET starts_at = ? WHERE id = ?").bind(now - 3600_000, party).run();
    expect((await edit({ starts_at: now - 3600_000, ends_at: now + 3600_000, name: "Still on" })).status).toBe(200);
    expect((await edit({ rules: "No fights" })).status).toBe(200);
  });
});
