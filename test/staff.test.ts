import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId, newToken } from "../src/lib/crypto";
import { api, harness, listLog, logEntry, ORIGIN, seedOwner, seedParty, seedSession } from "./helpers";

async function setup() {
  const h = await harness();
  const party = await seedParty();
  const owner = await seedOwner(party);
  const os = await seedSession(party, owner.id, "owner", h.clock);
  return { h, party, owner, os };
}

describe("CSRF and roles", () => {
  it("state-changing requests need our Origin and the session's CSRF token", async () => {
    const { h, os } = await setup();
    const body = { staff_id: newId(), invite_id: newId(), name: "A", email: "a@gmail.com", role: "admin" };
    const noCsrf = api(os, body);
    delete (noCsrf.headers as Record<string, string>)["x-sahra-csrf"];
    expect((await h.req("/api/staff/google-invite", noCsrf)).status).toBe(403);

    const wrongCsrf = api(os, body);
    (wrongCsrf.headers as Record<string, string>)["x-sahra-csrf"] = (await seedSession("x", "y", "owner", h.clock).catch(() => ({ csrf: "A".repeat(43) }))).csrf;
    expect((await h.req("/api/staff/google-invite", wrongCsrf)).status).toBe(403);

    const crossSite = api(os, body);
    (crossSite.headers as Record<string, string>).origin = "https://evil.example";
    expect((await h.req("/api/staff/google-invite", crossSite)).status).toBe(403);

    const fetchSite = api(os, body);
    (fetchSite.headers as Record<string, string>)["sec-fetch-site"] = "cross-site";
    expect((await h.req("/api/staff/google-invite", fetchSite)).status).toBe(403);

    expect((await h.req("/api/staff/google-invite", api(os, body))).status).toBe(200);
  });

  it("admins and door staff cannot manage staff", async () => {
    const { h, party } = await setup();
    const admin = await seedOwner(party, `sub-${newId()}`, "admin");
    const as = await seedSession(party, admin.id, "admin", h.clock);
    const r = await h.req("/api/staff/door-invite", api(as, { staff_id: newId(), invite_id: newId(), name: "D", token: newToken() }));
    expect(r.status).toBe(403);
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": as.token } })).status).toBe(403);
  });
});

describe("staff management", () => {
  it("google invite: creates staff + invite once, retry is recognized, duplicates refused", async () => {
    const { h, party, os } = await setup();
    const body = { staff_id: newId(), invite_id: newId(), name: "Rokaia", email: "Rokaia.A@gmail.com", role: "admin" };
    const r1 = await h.req("/api/staff/google-invite", api(os, body));
    expect(await r1.json()).toEqual({ status: "created", email: "rokaiaa@gmail.com" });
    const r2 = await h.req("/api/staff/google-invite", api(os, body));
    expect(await r2.json()).toEqual({ status: "already", email: "rokaiaa@gmail.com" });
    const dup = await h.req("/api/staff/google-invite", api(os, { ...body, staff_id: newId(), invite_id: newId() }));
    expect(dup.status).toBe(409);
    expect(await listLog(`log/${party}/staff/${body.staff_id}/`)).toHaveLength(1);
    const list = (await (await h.req("/api/staff", { cookies: { "__Host-sahra_s": os.token } })).json()) as { staff: unknown[]; invites: unknown[] };
    expect(list.staff.length).toBe(2);
    expect(list.invites.length).toBe(1);
  });

  it("role change revokes that person's sessions; the last owner cannot be demoted or disabled", async () => {
    const { h, party, owner, os } = await setup();
    const admin = await seedOwner(party, `sub-${newId()}`, "admin");
    const as = await seedSession(party, admin.id, "admin", h.clock);

    expect((await h.req(`/api/staff/${owner.id}/role`, api(os, { role: "admin" }))).status).toBe(409);
    expect((await h.req(`/api/staff/${owner.id}/disable`, api(os))).status).toBe(409);

    const promote = await h.req(`/api/staff/${admin.id}/role`, api(os, { role: "owner" }));
    expect(await promote.json()).toEqual({ status: "changed" });
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": as.token } })).status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE staff_id = ? AND revoked_at IS NULL").bind(admin.id).first("n")).toBe(0);

    // Now there are two owners: the first one may step down (and their own session ends).
    const down = await h.req(`/api/staff/${owner.id}/role`, api(os, { role: "admin" }));
    expect(await down.json()).toEqual({ status: "changed" });
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": os.token } })).status).toBe(401);
    const logs = await listLog(`log/${party}/staff/${admin.id}/`);
    expect(logs.at(-1)).toBe(`log/${party}/staff/${admin.id}/0000000002.json`);
    const entry = await logEntry("staff", admin.id, 2);
    expect(entry).toMatchObject({ entity: "staff", entity_id: admin.id, rev: 2, action: "role_changed", state: { role: "owner" } });
  });

  it("disabling door staff revokes their session and their unused invitations", async () => {
    const { h, party, os } = await setup();
    const staffId = newId();
    const t1 = newToken();
    await h.req("/api/staff/door-invite", api(os, { staff_id: staffId, invite_id: newId(), name: "Lily", token: t1 }));
    const v = newToken();
    await h.req("/api/invites/consume", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: t1, session: v }),
    });
    const t2 = newToken();
    await h.req("/api/staff/door-invite", api(os, { staff_id: staffId, invite_id: newId(), token: t2 }));
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": v } })).status).toBe(200);

    expect(await (await h.req(`/api/staff/${staffId}/disable`, api(os))).json()).toEqual({ status: "disabled" });
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": v } })).status).toBe(401);
    const join2 = await h.req("/api/invites/consume", {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: t2, session: newToken() }),
    });
    expect(join2.status).toBe(410);
    expect(await (await h.req(`/api/staff/${staffId}/disable`, api(os))).json()).toEqual({ status: "already" });
    // Re-inviting a disabled person is refused.
    const again = await h.req("/api/staff/door-invite", api(os, { staff_id: staffId, invite_id: newId(), token: newToken() }));
    expect(again.status).toBe(409);
    expect((await listLog(`log/${party}/staff/${staffId}/`)).length).toBe(2);
  });

  it("an action whose log write fails reports pending, and the retry completes it", async () => {
    const { h, party, os } = await setup();
    const admin = await seedOwner(party, `sub-${newId()}`, "admin");
    h.ledger.mode = "fail";
    const r1 = await h.req(`/api/staff/${admin.id}/disable`, api(os));
    expect(r1.status).toBe(503);
    expect(await r1.json()).toMatchObject({ status: "pending" });
    h.ledger.mode = "ok";
    const r2 = await h.req(`/api/staff/${admin.id}/disable`, api(os));
    expect(await r2.json()).toEqual({ status: "already" });
    expect(await listLog(`log/${party}/staff/${admin.id}/`)).toEqual([`log/${party}/staff/${admin.id}/0000000002.json`]);
  });

  it("audit records who did what", async () => {
    const { h, party, owner, os } = await setup();
    const admin = await seedOwner(party, `sub-${newId()}`, "admin");
    await h.req(`/api/staff/${admin.id}/role`, api(os, { role: "owner" }));
    const rows = await env.DB.prepare("SELECT actor_staff_id, action, entity_id, entity_rev, detail FROM audit WHERE party_id = ? ORDER BY id").bind(party).all();
    expect(rows.results).toContainEqual({ actor_staff_id: owner.id, action: "role_changed", entity_id: admin.id, entity_rev: 2, detail: "owner" });
  });
});

describe("rate limiting", () => {
  it("the Workers rate limit binding blocks after the limit", async () => {
    const key = `t-${newId()}`;
    const results = [];
    for (let i = 0; i < 5; i++) results.push((await env.RL_TEST.limit({ key })).success);
    expect(results).toEqual([true, true, true, false, false]);
  });
});
