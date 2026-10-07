// Browsers decide the Origin header from the page's referrer policy. With
// "no-referrer", every POST (even same-origin) carries `Origin: null`, and our
// Origin check rejects it: sign-in, door join and every staff action would fail
// in a real browser while API tests that set Origin by hand still pass. This test
// pins the policy on both the Worker's responses and the static pages.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { harness, ORIGIN } from "./helpers";

const SENDS_ORIGIN_ON_SAME_ORIGIN_POST = new Set([
  "same-origin", "origin", "strict-origin", "origin-when-cross-origin",
  "strict-origin-when-cross-origin", "no-referrer-when-downgrade", "unsafe-url",
]);

describe("referrer policy keeps a real Origin on our own POSTs", () => {
  it("Worker responses (including the sign-in pages) use same-origin", async () => {
    const h = await harness();
    for (const r of [
      await h.req("/api/me"),
      await h.req("/api/auth/google/callback?error=access_denied"),
      await h.req("/api/auth/google/start", { method: "POST", headers: { origin: ORIGIN } }),
    ]) {
      const p = r.headers.get("referrer-policy")!;
      expect(p).toBe("same-origin");
      expect(SENDS_ORIGIN_ON_SAME_ORIGIN_POST.has(p)).toBe(true);
    }
  });

  it("static pages (public/_headers) use same-origin", () => {
    const m = /Referrer-Policy:\s*(\S+)/i.exec(env.TEST_ASSET_HEADERS);
    expect(m?.[1]).toBe("same-origin");
  });
});
