// What a D1 outage does. Main = sahra-prod, ledger = sahra-ledger.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { newId, newToken } from "../src/lib/crypto";
import { api, googleLogin, harness, OutageDriver, seedOwner, seedParty, seedSession } from "./helpers";

afterEach(() => { OutageDriver.down = { main: false, ledger: false }; });

async function setup() {
  const h = await harness();
  const party = await seedParty();
  const owner = await seedOwner(party, `g-${newId()}`);
  const os = await seedSession(party, owner.id, "owner", h.clock);
  const { qr } = (await (await h.req("/api/proto/ticket", api(os, {}))).json()) as { qr: string };
  return { h, party, owner, os, qr };
}

describe("main database unreachable", () => {
  it("sign-in fails without a session; staff changes, session checks and scans answer 503 (no green)", async () => {
    const { h, owner, os, qr, party } = await setup();
    OutageDriver.down.main = true;
    h.google.identity = { sub: (await env.DB.prepare("SELECT google_sub FROM staff WHERE id = ?").bind(owner.id).first("google_sub")) as string, email: "x@gmail.com" };
    const login = await googleLogin(h);
    expect(login.res.status).toBe(503);
    expect(login.cookies["__Host-sahra_s"]).toBeUndefined();
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": os.token } })).status).toBe(503);
    const admin = await (OutageDriver.down.main = false, seedOwner(party, `g-${newId()}`, "admin"));
    OutageDriver.down.main = true;
    expect((await h.req(`/api/staff/${admin.id}/disable`, api(os))).status).toBe(503);
    OutageDriver.down.main = false;
    expect(await env.DB.prepare("SELECT disabled_at FROM staff WHERE id = ?").bind(admin.id).first("disabled_at")).toBeNull();
    OutageDriver.down.main = true;
    expect((await h.req("/api/proto/scan", api(os, { scan_id: newId(), qr }))).status).toBe(503);
  });

  it("scan during an outage after the session check: cant_verify, never admit", async () => {
    const { h, os, qr } = await setup();
    // Fail only the redemption batch (the 2nd main-database call of the request).
    let calls = 0;
    const realCheck = OutageDriver.prototype["check" as never] as () => void;
    (OutageDriver.prototype as unknown as { check: () => void }).check = function (this: { which: string }) {
      if (this.which === "main" && ++calls === 2) throw new Error("D1_ERROR: Network connection lost.");
    };
    try {
      const r = await (await h.req("/api/proto/scan", api(os, { scan_id: newId(), qr }))).json();
      expect(r).toEqual({ verdict: "cant_verify" });
    } finally {
      (OutageDriver.prototype as unknown as { check: () => void }).check = realCheck;
    }
    // Once the database is back, the same ticket is admitted exactly once.
    const again = await (await h.req("/api/proto/scan", api(os, { scan_id: newId(), qr }))).json();
    expect(again).toMatchObject({ verdict: "admit" });
  });
});

describe("ledger database unreachable", () => {
  it("staff changes are not confirmed (pending) and a retry completes them; scans never go green", async () => {
    const { h, party, os, qr } = await setup();
    const admin = await seedOwner(party, `g-${newId()}`, "admin");
    OutageDriver.down.ledger = true;
    const r = await h.req(`/api/staff/${admin.id}/disable`, api(os));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ status: "pending" });
    const scan = await (await h.req("/api/proto/scan", api(os, { scan_id: newId(), qr }))).json();
    expect(scan).toEqual({ verdict: "cant_verify" });
    const join = await h.req("/api/staff/door-invite", api(os, { staff_id: newId(), invite_id: newId(), name: "D", token: newToken() }));
    expect(join.status).toBe(503);
    OutageDriver.down.ledger = false;
    expect(await (await h.req(`/api/staff/${admin.id}/disable`, api(os))).json()).toEqual({ status: "already" });
  });
});
