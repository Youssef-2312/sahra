import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Driver } from "../src/db/driver";
import { Db } from "../src/db";
import { newId, newToken, sha256hex } from "../src/lib/crypto";
import { api, harness, listLog, ORIGIN, seedOwner, seedParty, seedSession, setCookies, type Harness } from "./helpers";

async function setup() {
  const h = await harness();
  const party = await seedParty();
  const owner = await seedOwner(party);
  const os = await seedSession(party, owner.id, "owner", h.clock);
  return { h, party, owner, os };
}

async function doorInvite(h: Harness, os: { token: string; csrf: string }, body: Partial<{ staff_id: string; name: string | null; hours: number }> = {}) {
  const token = newToken();
  const staffId = body.staff_id ?? newId();
  const inviteId = newId();
  const r = await h.req("/api/staff/door-invite", api(os, { staff_id: staffId, invite_id: inviteId, name: "Malek", token, ...body }));
  return { r, token, staffId, inviteId };
}

function join(h: Harness, token: string, session: string) {
  return h.req("/api/invites/consume", {
    method: "POST",
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ token, session }),
  });
}

describe("door invitations", () => {
  it("owner creates an invitation; joining creates a door session; only hashes are stored", async () => {
    const { h, party, os } = await setup();
    const inv = await doorInvite(h, os);
    expect(inv.r.status).toBe(200);
    const row = await env.DB.prepare("SELECT token_hash FROM invites WHERE id = ?").bind(inv.inviteId).first();
    expect(row!.token_hash).toBe(await sha256hex(inv.token));

    const session = newToken();
    const j = await join(h, inv.token, session);
    expect(j.status).toBe(200);
    const ck = setCookies(j)["__Host-sahra_s"]!;
    expect(ck.value).toBe(session);
    expect(ck.attrs).toMatch(/SameSite=Strict/);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?").bind(session).first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id_hash = ?").bind(await sha256hex(session)).first("n")).toBe(1);

    const me = await (await h.req("/api/me", { cookies: { "__Host-sahra_s": session } })).json();
    expect(me).toMatchObject({ party: { id: party }, staff: { id: inv.staffId, role: "door" }, kind: "door" });
    // The invitation use is in the change log (rev 1 created, rev 2 used).
    expect(await listLog(`log/${party}/invite/${inv.inviteId}/`)).toEqual([
      `log/${party}/invite/${inv.inviteId}/0000000001.json`,
      `log/${party}/invite/${inv.inviteId}/0000000002.json`,
    ]);
  });

  it("same invitation consumed many times at once: exactly one session", async () => {
    const { h, os } = await setup();
    const inv = await doorInvite(h, os);
    const values = Array.from({ length: 12 }, () => newToken());
    const results = await Promise.all(values.map((v) => join(h, inv.token, v)));
    const ok = results.filter((r) => r.status === 200);
    expect(ok.length).toBe(1);
    for (const r of results.filter((r) => r.status !== 200)) {
      expect(r.status).toBe(409);
      expect(await r.json()).toEqual({ error: "invitation_already_used" });
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE invite_id = ?").bind(inv.inviteId).first("n")).toBe(1);
  });

  it("a retry with the same browser value succeeds again; any other value gets 'already used'", async () => {
    const { h, os } = await setup();
    const inv = await doorInvite(h, os);
    const v = newToken();
    expect((await join(h, inv.token, v)).status).toBe(200);
    const again = await join(h, inv.token, v);
    expect(again.status).toBe(200);
    expect(setCookies(again)["__Host-sahra_s"]!.value).toBe(v);
    const other = await join(h, inv.token, newToken());
    expect(other.status).toBe(409);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE invite_id = ?").bind(inv.inviteId).first("n")).toBe(1);
  });

  it("validates token and session value length and encoding", async () => {
    const { h, os } = await setup();
    const inv = await doorInvite(h, os);
    const good = newToken();
    for (const [t, s] of [
      [inv.token.slice(0, 42), good],
      [inv.token + "A", good],
      [inv.token, good.slice(0, 42)],
      [inv.token, good.replace(/.$/, "=")],
      [inv.token, "+".repeat(43)],
      [inv.token, inv.token],
      [inv.token, 12345],
      // 43 chars but a non-canonical final character (extra bits set).
      [inv.token, good.slice(0, 42) + (good.endsWith("B") ? "C" : "B")],
    ] as const) {
      const r = await h.req("/api/invites/consume", {
        method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ token: t, session: s }),
      });
      expect(r.status).toBe(400);
    }
  });

  it("refuses joins from another origin", async () => {
    const { h, os } = await setup();
    const inv = await doorInvite(h, os);
    const r = await h.req("/api/invites/consume", {
      method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ token: inv.token, session: newToken() }),
    });
    expect(r.status).toBe(403);
  });

  it("revoking an invitation revokes the session created from it", async () => {
    const { h, party, os } = await setup();
    const inv = await doorInvite(h, os);
    const v = newToken();
    expect((await join(h, inv.token, v)).status).toBe(200);
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": v } })).status).toBe(200);

    const rv = await h.req(`/api/invites/${inv.inviteId}/revoke`, api(os));
    expect(rv.status).toBe(200);
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": v } })).status).toBe(401);
    // And the same browser value can no longer rejoin.
    expect((await join(h, inv.token, v)).status).toBe(410);
    expect(await listLog(`log/${party}/invite/${inv.inviteId}/`)).toHaveLength(3);
    // Idempotent.
    expect(await (await h.req(`/api/invites/${inv.inviteId}/revoke`, api(os))).json()).toEqual({ status: "already" });
  });

  it("an unused revoked or expired invitation cannot be used", async () => {
    const { h, os } = await setup();
    const a = await doorInvite(h, os);
    await h.req(`/api/invites/${a.inviteId}/revoke`, api(os));
    expect((await join(h, a.token, newToken())).status).toBe(410);

    const b = await doorInvite(h, os, { hours: 1 });
    h.clock.advance(3600_000 + 1);
    expect((await join(h, b.token, newToken())).status).toBe(410);
  });

  it("re-inviting a door staff member replaces their unused invitation", async () => {
    const { h, os } = await setup();
    const a = await doorInvite(h, os);
    const b = await doorInvite(h, os, { staff_id: a.staffId, name: null });
    expect(b.r.status).toBe(200);
    expect((await join(h, a.token, newToken())).status).toBe(410);
    expect((await join(h, b.token, newToken())).status).toBe(200);
  });

  it("does not confirm the join until the change log is written; the retry finishes it", async () => {
    const { h, party, os } = await setup();
    const inv = await doorInvite(h, os);
    const v = newToken();
    h.ledger.mode = "fail";
    const r1 = await join(h, inv.token, v);
    expect(r1.status).toBe(503);
    expect(await r1.json()).toMatchObject({ status: "pending", retry: true });
    expect(setCookies(r1)["__Host-sahra_s"]).toBeUndefined();
    h.ledger.mode = "lose_ack";
    expect((await join(h, inv.token, v)).status).toBe(503);
    h.ledger.mode = "ok";
    const r3 = await join(h, inv.token, v);
    expect(r3.status).toBe(200);
    expect(setCookies(r3)["__Host-sahra_s"]!.value).toBe(v);
    expect(await listLog(`log/${party}/invite/${inv.inviteId}/`)).toHaveLength(2);
  });

  it("door join is refused above 10 sessions per staff member per hour; the invitation stays unused", async () => {
    const { h, party, os } = await setup();
    const inv = await doorInvite(h, os);
    for (let i = 0; i < 10; i++) await seedSession(party, inv.staffId, "door", h.clock);
    const r = await join(h, inv.token, newToken());
    expect(r.status).toBe(429);
    expect(await r.json()).toEqual({ error: "too_many_sessions" });
    expect(await env.DB.prepare("SELECT used_at FROM invites WHERE id = ?").bind(inv.inviteId).first("used_at")).toBeNull();
  });

  it("an expired door session is rejected", async () => {
    const { h, os } = await setup();
    const inv = await doorInvite(h, os);
    const v = newToken();
    await join(h, inv.token, v);
    h.clock.advance(16 * 3600_000 + 1);
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": v } })).status).toBe(401);
  });
});

describe("session checks inside the database operation", () => {
  it("a session revoked, expired, or whose staff was disabled after the request check cannot change anything", async () => {
    const { h, party, owner } = await setup();
    const db = new Db(new D1Driver(env.DB));
    const now = h.clock.now();

    for (const kill of ["revoke", "expire", "disable", "role"] as const) {
      const o = await seedOwner(party);
      const s = await seedSession(party, o.id, "owner", h.clock);
      // The request-level check would have passed here...
      expect(await db.getSession(s.hash, now)).not.toBeNull();
      // ...then the session becomes invalid before the write runs.
      if (kill === "revoke") await env.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id_hash = ?").bind(s.hash).run();
      if (kill === "expire") await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id_hash = ?").bind(now, s.hash).run();
      if (kill === "disable") await env.DB.prepare("UPDATE staff SET disabled_at = 1 WHERE id = ?").bind(o.id).run();
      if (kill === "role") await env.DB.prepare("UPDATE staff SET role = 'admin' WHERE id = ?").bind(o.id).run();
      const ref = { hash: s.hash, partyId: party };
      const staffId = newId();
      expect(await db.createDoorInvite(ref, o.id, {
        staffId, inviteId: newId(), name: "X", tokenHash: await sha256hex(newToken()), now, expiresAt: now + 1e6, op: newId(),
      }), kill).toBe("rejected");
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE id = ?").bind(staffId).first("n"), kill).toBe(0);
      expect(await db.disableStaff(ref, o.id, owner.id, now, newId()), kill).toBe("rejected");
      expect(await db.changeRole(ref, o.id, owner.id, "admin", now, newId()), kill).toBe("rejected");
    }
    expect((await env.DB.prepare("SELECT role, disabled_at FROM staff WHERE id = ?").bind(owner.id).first())).toEqual({ role: "owner", disabled_at: null });
  });

  it("a session from one party cannot act on another party", async () => {
    const { h, os } = await setup();
    const other = await seedParty();
    const otherOwner = await seedOwner(other);
    const r = await h.req(`/api/staff/${otherOwner.id}/disable`, api(os));
    expect(r.status).toBe(409);
    expect(await env.DB.prepare("SELECT disabled_at FROM staff WHERE id = ?").bind(otherOwner.id).first("disabled_at")).toBeNull();
  });
});
