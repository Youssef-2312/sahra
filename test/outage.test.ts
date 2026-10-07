// What a D1 outage does. Main = sahra-prod, ledger = sahra-ledger.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { newId, newToken } from "../src/lib/crypto";
import { api, googleLogin, harness, openParty, OutageDriver, scan, seedDoor, seedOwner, testTickets } from "./helpers";

afterEach(() => { OutageDriver.down = { main: false, ledger: false }; });

async function setup() {
  const h = await harness();
  const { party, owner, os } = await openParty(h);
  const door = await seedDoor(party, h.clock);
  const [t] = await testTickets(h, os);
  return { h, party, owner, os, door, qr: t!.qr };
}

describe("main database unreachable", () => {
  it("sign-in fails without a session; staff changes and session checks answer 503; scans cant_verify", async () => {
    const { h, owner, os, door, qr, party } = await setup();
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
    expect(await scan(h, door, qr)).toEqual({ verdict: "cant_verify" });
  });

  it("scan when the redemption batch cannot run: cant_verify, never admit; admitted once the database is back", async () => {
    const { h, door, qr } = await setup();
    OutageDriver.down.main = true;
    expect(await scan(h, door, qr)).toEqual({ verdict: "cant_verify" });
    OutageDriver.down.main = false;
    expect((await scan(h, door, qr)).verdict).toBe("admit");
  });
});

describe("ledger database unreachable", () => {
  it("staff changes are not made (pending: their intent cannot be written) and a retry makes them; scans never go green", async () => {
    const { h, party, os, door, qr } = await setup();
    const admin = await seedOwner(party, `g-${newId()}`, "admin");
    OutageDriver.down.ledger = true;
    const r = await h.req(`/api/staff/${admin.id}/disable`, api(os));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ status: "pending" });
    expect(await scan(h, door, qr)).toEqual({ verdict: "cant_verify" });
    const join = await h.req("/api/staff/door-invite", api(os, { staff_id: newId(), invite_id: newId(), name: "D", token: newToken() }));
    expect(join.status).toBe(503);
    OutageDriver.down.ledger = false;
    expect((await env.DB.prepare("SELECT disabled_at FROM staff WHERE id = ?").bind(admin.id).first("disabled_at"))).toBeNull();
    expect(await (await h.req(`/api/staff/${admin.id}/disable`, api(os))).json()).toEqual({ status: "disabled" });
  });
});
