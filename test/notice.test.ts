// Pages the server answers itself (src/auth/notices.ts, public/js/notice.js):
// a page address that is not a file gets the site's "page not found" (HTML, 404),
// API addresses keep JSON, and sign-in outcomes are the site's page with the
// message key, the English text and the scripts that show it in either language.
import { describe, expect, it, vi } from "vitest";
import { harness } from "./helpers";

vi.spyOn(console, "log").mockImplementation(() => {});

describe("server pages", () => {
  it("a missing page is an HTML 404 in the site's look; a missing API address stays JSON", async () => {
    const h = await harness();
    const r = await h.req("/no-such-page");
    expect(r.status).toBe(404);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    const html = await r.text();
    expect(html).toContain('data-notice="not_found"');
    expect(html).toContain("Page not found");
    expect(html).toContain('<link rel="stylesheet" href="/css/sahra.css">');
    expect(html).toContain('<script src="/js/notice.js"></script>');
    expect(html).not.toMatch(/<script>|style=/);
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");

    const api = await h.req("/api/no-such-thing");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "not_found" });
    const post = await h.req("/no-such-page", { method: "POST" });
    expect(post.status).toBe(404);
    expect(await post.json()).toEqual({ error: "not_found" });
  });

  it("sign-in outcomes are pages: cancelled, wrong origin, and a code shown escaped", async () => {
    const h = await harness();
    const cancelled = await h.req("/api/auth/google/callback?error=access_denied");
    expect(cancelled.status).toBe(400);
    const c = await cancelled.text();
    expect(c).toContain('data-notice="cancelled"');
    expect(c).toContain('data-back="/signin"');

    const evil = await h.req("/api/auth/platform/start", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(evil.status).toBe(403);
    const e = await evil.text();
    expect(e).toContain('data-notice="bad_origin"');
    expect(e).toContain('data-back="/platform"');
  });
});
