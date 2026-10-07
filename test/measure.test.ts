// Local timing of the CPU-heavy pieces, in workerd. These are LOCAL numbers only;
// Checkpoint A measures the real CPU time on Cloudflare.
import { describe, expect, it } from "vitest";
import { verifyIdToken, JwksCache } from "../src/auth/google";
import { base32, deriveHmacKey, hmac, sha256hex, newToken } from "../src/lib/crypto";
import { Clock, FakeGoogle } from "./helpers";

async function time(label: string, n: number, f: () => Promise<unknown>) {
  await f();
  const t0 = performance.now();
  for (let i = 0; i < n; i++) await f();
  const ms = (performance.now() - t0) / n;
  console.log(JSON.stringify({ evt: "measure", what: label, ms_per_op: Number(ms.toFixed(4)), n }));
  return ms;
}

describe("local timings (workerd)", () => {
  it("ID token verification, JWKS import, QR HMAC", async () => {
    const clock = new Clock();
    const g = await FakeGoogle.create();
    const fetcher = g.fetcher(clock);
    const nonce = newToken();
    const nonceHash = await sha256hex(nonce);
    const tok = await g.idToken(nonce, clock.now());
    const warm = new JwksCache(fetcher);
    await time("verify_id_token_cached_keys", 200, () =>
      verifyIdToken(tok, { clientId: "test-client.apps.googleusercontent.com", expectedNonceHash: nonceHash, jwks: warm, nowMs: clock.now() }));
    await time("verify_id_token_cold_jwks_including_import", 50, () =>
      verifyIdToken(tok, { clientId: "test-client.apps.googleusercontent.com", expectedNonceHash: nonceHash, jwks: new JwksCache(fetcher), nowMs: clock.now() }));
    const env = { QR_MASTER_K1: "dGVzdC1vbmx5LXFyLW1hc3Rlci1zZWNyZXQtMzItYnl0ZXM" };
    await time("qr_hmac_with_cached_derived_key", 500, async () => {
      const k = await deriveHmacKey(env, "QR", "measure", 1);
      return base32(await hmac(k, "S1.MEASURE.10123456789ABCDEF.1"), 26);
    });
    let i = 0;
    await time("hkdf_derive_uncached", 100, () => deriveHmacKey(env, "QR", `m${i++}`, 1));
    expect(true).toBe(true);
  });
});
