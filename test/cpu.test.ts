// CPU pass: work that is cached per isolate instead of repeated per request.
import { describe, expect, it, vi } from "vitest";
import { JwksCache, verifyIdToken } from "../src/auth/google";
import { b64url, csrfFor, deriveHmacKey, newToken, parseToken, sha256, sha256hex } from "../src/lib/crypto";
import { Clock, FakeGoogle, harness } from "./helpers";

describe("Google keys", () => {
  it("imports only the key a token names, once per isolate, and keeps it across a refresh", async () => {
    const clock = new Clock();
    const g = await FakeGoogle.create();
    await g.rotate("key-2"); // Google publishes two keys
    const jwks = new JwksCache(g.fetcher(clock), 60_000);
    const spy = vi.spyOn(crypto.subtle, "importKey");
    const nonce = newToken();
    const check = async () =>
      verifyIdToken(await g.idToken(nonce, clock.now()), {
        clientId: "test-client.apps.googleusercontent.com", expectedNonceHash: await sha256hex(nonce), jwks, nowMs: clock.now(),
      });
    await check();
    await check();
    expect(jwks.importedCount).toBe(1);
    const rsaImports = () => spy.mock.calls.filter((c) => c[0] === "jwk").length;
    expect(rsaImports()).toBe(1);
    // Cache expires; Google still publishes the same keys: refetch, but no new import.
    clock.advance(20_001_000);
    await check();
    expect(g.jwksFetches).toBe(2);
    expect(rsaImports()).toBe(1);
    spy.mockRestore();
  });
});

describe("per-party keys", () => {
  it("are derived once per isolate and then reused", async () => {
    const env = { QR_MASTER_K1: "dGVzdC1vbmx5LXFyLW1hc3Rlci1zZWNyZXQtMzItYnl0ZXM" };
    const spy = vi.spyOn(crypto.subtle, "deriveBits");
    const a = await deriveHmacKey(env, "QR", "cpu-party", 1);
    const b = await deriveHmacKey(env, "QR", "cpu-party", 1);
    expect(a).toBe(b);
    expect(spy.mock.calls.length).toBe(1);
    spy.mockRestore();
  });
});

describe("CSRF token", () => {
  it("is SHA-256('sahra-csrf-v2|' + raw token), the formula scripts/checkpoint-a.mjs uses, with no key import", async () => {
    const t = newToken();
    const spy = vi.spyOn(crypto.subtle, "importKey");
    const got = await csrfFor(parseToken(t)!);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    const label = new TextEncoder().encode("sahra-csrf-v2|");
    const raw = parseToken(t)!;
    const buf = new Uint8Array(label.length + raw.length);
    buf.set(label);
    buf.set(raw, label.length);
    expect(got).toBe(b64url(await sha256(buf)));
    // Not the stored session hash.
    expect(got).not.toBe(await sha256hex(t));
  });
});

describe("cold/warm label", () => {
  it("every request log line carries iso_req and cold", async () => {
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((m: unknown) => { lines.push(String(m)); });
    const h = await harness();
    await h.req("/api/me");
    await h.req("/api/me");
    spy.mockRestore();
    const reqs = lines.filter((l) => l.startsWith('{"evt":"req"')).map((l) => JSON.parse(l));
    expect(reqs.length).toBe(2);
    expect(reqs[1].iso_req).toBe(reqs[0].iso_req + 1);
    expect(reqs[1].cold).toBe(false);
    expect(typeof reqs[0].iso_age_ms).toBe("number");
  });
});
