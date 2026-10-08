// Losing authority takes effect on sessions that are ALREADY OPEN: the next
// request is refused, requests racing the change either completed before it (and
// are logged) or are refused, and a retry with the same ids afterwards is
// refused. Every write statement on these paths carries the authority condition
// itself, so the DB-level checks below call the statements directly with a
// session that (artificially) escaped revocation.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { Db } from "../src/db";
import { D1Driver } from "../src/db/driver";
import { newId, newToken } from "../src/lib/crypto";
import { PlatformDb } from "../src/platform/db";
import {
  api, googleLogin, harness, logEntry, papi, scan, seedDoor, seedOrganiser, seedOwner, seedParty, seedPlatformSession,
  seedSession, seedSiteOwner, testTickets, type Harness,
} from "./helpers";

type Sess = { token: string; csrf: string; hash: string };
const pid = () => `pa-${newId().slice(0, 8)}`;
const db = () => new Db(new D1Driver(env.DB));
const pdb = () => new PlatformDb(new D1Driver(env.DB));

async function siteOwner(h: Harness) {
  const a = await seedSiteOwner();
  return { ...a, s: await seedPlatformSession(a.sub, h.clock) };
}

/** An organiser (party limit raised) who created a party and has a party owner session in it. */
async function organiserWithParty(h: Harness, so: { s: Sess }, limit = 1) {
  const o = await seedOrganiser();
  const os = await seedPlatformSession(o.sub, h.clock);
  if (limit > 1) expect((await h.req(`/api/platform/organisers/${o.id}/party-limit`, papi(so.s, { limit }))).status).toBe(200);
  const party = pid();
  const staffId = newId();
  const r = await h.req("/api/platform/parties", papi(os, { id: party, name: `Party ${party}`, capacity: 50, staff_id: staffId }));
  expect(r.status).toBe(200);
  const owner = await seedSession(party, staffId, "owner", h.clock);
  return { o, os, party, staffId, owner };
}

function googleInvite(h: Harness, s: { token: string; csrf: string }, ids = { staff_id: newId(), invite_id: newId() }) {
  return h.req("/api/staff/google-invite", api(s, { ...ids, name: "New", email: `n-${ids.staff_id.slice(0, 8)}@gmail.com`, role: "admin" }));
}

const unrevoke = (hash: string, table = "sessions") => env.DB.prepare(`UPDATE ${table} SET revoked_at = NULL WHERE id_hash = ?`).bind(hash).run();
const auditId = (action: string, entityId: string) =>
  env.DB.prepare("SELECT MIN(id) AS id FROM audit WHERE action = ? AND entity_id = ?").bind(action, entityId).first<number>("id");

describe("switching off an organiser ends their party management", () => {
  it("disables every staff row of their account in the same batch; the party keeps running for guests and other staff", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const { o, party, staffId, owner } = await organiserWithParty(h, so);
    // The same Google account is also staff at someone else's party.
    const other = await seedParty();
    const otherRow = await seedOwner(other, o.sub, "admin");
    const otherOwner = await seedOwner(other);
    // Party running: admission open, a door phone, a ticket.
    expect((await h.req("/api/admission", api(owner, { action: "open" }))).status).toBe(200);
    const door = await seedDoor(party, h.clock);
    const [t1, t2] = await testTickets(h, owner, 2);
    expect(await scan(h, door, t1!.qr)).toMatchObject({ verdict: "admit" });
    const unusedDoorInvite = newToken();
    expect((await h.req("/api/staff/door-invite", api(owner, { staff_id: newId(), invite_id: newId(), name: "Later", token: unusedDoorInvite }))).status).toBe(200);

    const r = await h.req(`/api/platform/organisers/${o.id}/disable`, papi(so.s));
    expect(await r.json()).toEqual({ status: "disabled", staff_disabled: 2 });

    for (const id of [staffId, otherRow.id]) {
      const st = await env.DB.prepare("SELECT disabled_at, rev, logged_rev, last_action FROM staff WHERE id = ?").bind(id).first();
      expect(st).toMatchObject({ last_action: "staff_disabled" });
      expect(st!.disabled_at).not.toBeNull();
      expect(st!.logged_rev).toBe(st!.rev);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE staff_id = ? AND revoked_at IS NULL").bind(id).first("n")).toBe(0);
      expect(await env.DB.prepare("SELECT detail FROM audit WHERE action = 'staff_disabled' AND entity_id = ?").bind(id).first("detail")).toBe("organiser switched off");
    }
    // Intents for the organiser and for each staff row, under the same op id.
    const intents = await env.LEDGER.prepare("SELECT entity, entity_id, party_id, op_id FROM intents WHERE entity_id IN (?, ?, ?)")
      .bind(o.id, staffId, otherRow.id).all<{ entity: string; entity_id: string; party_id: string; op_id: string }>();
    expect(intents.results.map((x) => `${x.entity}:${x.party_id}`).sort()).toEqual([`organiser:_platform`, `staff:${other}`, `staff:${party}`].sort());
    expect(new Set(intents.results.map((x) => x.op_id)).size).toBe(1);
    // Other staff unaffected: the door phone keeps admitting; the other party's owner keeps their role.
    expect(await scan(h, door, t2!.qr)).toMatchObject({ verdict: "admit" });
    expect(await env.DB.prepare("SELECT disabled_at FROM staff WHERE id = ?").bind(otherOwner.id).first("disabled_at")).toBeNull();
    // An unused invitation created by the organiser for someone else stays valid (it is not theirs).
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE party_id = ? AND kind = 'door' AND revoked_at IS NULL AND used_at IS NULL").bind(party).first("n")).toBe(1);

    // The site owner sees the party has no active owner.
    const counts = (await (await h.req("/api/platform/parties", { cookies: { "__Host-sahra_p": so.s.token } })).json()) as { parties: Record<string, unknown>[] };
    expect(counts.parties.find((x) => x.id === party)).toMatchObject({ no_active_owner: true, active_owners: 0 });
    expect(counts.parties.find((x) => x.id === other)).toMatchObject({ no_active_owner: false });
  });

  it("a site owner appoints a new owner for a party without one; refused while it has one", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const { o, party } = await organiserWithParty(h, so);
    const body = { staff_id: newId(), invite_id: newId(), name: "New Owner", email: "New.Owner@gmail.com" };
    // While the organiser is still owner: refused.
    expect(await (await h.req(`/api/platform/parties/${party}/owner-invite`, papi(so.s, body))).json()).toEqual({ error: "party_has_an_active_owner" });
    expect((await h.req(`/api/platform/organisers/${o.id}/disable`, papi(so.s))).status).toBe(200);
    // Only site owners.
    const o2 = await seedOrganiser();
    expect((await h.req(`/api/platform/parties/${party}/owner-invite`, papi(await seedPlatformSession(o2.sub, h.clock), body))).status).toBe(403);
    expect((await h.req(`/api/platform/parties/no-such-party/owner-invite`, papi(so.s, body))).status).toBe(404);

    const r = await h.req(`/api/platform/parties/${party}/owner-invite`, papi(so.s, body));
    const j = (await r.json()) as { status: string; email: string; expires_at: number };
    expect(j).toMatchObject({ status: "created", email: "newowner@gmail.com" });
    expect(j.expires_at - h.clock.now()).toBe(14 * 24 * 3600_000);
    expect(await (await h.req(`/api/platform/parties/${party}/owner-invite`, papi(so.s, body))).json()).toMatchObject({ status: "already" });
    expect(await logEntry("staff", body.staff_id, 1)).not.toBeNull();
    expect(await logEntry("invite", body.invite_id, 1)).not.toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE party_id = ? AND detail = 'owner appointed by site owner'").bind(party).first("n")).toBe(2);

    // The new owner signs in with Google and runs the party.
    h.google.identity = { sub: "new-owner-sub", email: "newowner@gmail.com" };
    const login = await googleLogin(h);
    expect(login.res.status).toBe(200);
    const me = await (await h.req("/api/me", { cookies: { "__Host-sahra_s": login.cookies["__Host-sahra_s"]!.value } })).json();
    expect(me).toMatchObject({ party: { id: party }, staff: { id: body.staff_id, role: "owner" } });
    const again = { staff_id: newId(), invite_id: newId(), name: "Third", email: "third@gmail.com" };
    expect((await h.req(`/api/platform/parties/${party}/owner-invite`, papi(so.s, again))).status).toBe(409);
    const counts = (await (await h.req("/api/platform/parties", { cookies: { "__Host-sahra_p": so.s.token } })).json()) as { parties: Record<string, unknown>[] };
    expect(counts.parties.find((x) => x.id === party)).toMatchObject({ no_active_owner: false });
  });

  it("a disabled party gets no owner invitation", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const party = await seedParty();
    expect((await h.req(`/api/platform/parties/${party}/disable`, papi(so.s))).status).toBe(200);
    const body = { staff_id: newId(), invite_id: newId(), name: "X", email: "x-owner@gmail.com" };
    expect(await (await h.req(`/api/platform/parties/${party}/owner-invite`, papi(so.s, body))).json()).toEqual({ error: "party_disabled" });
  });
});

describe("open sessions lose authority on the very next request", () => {
  it("organiser switched off: next platform request and next party-owner request refused; statements refuse even an escaped session", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const { o, os, owner, party } = await organiserWithParty(h, so);
    // Working before.
    expect((await h.req("/api/platform/my-parties", { cookies: { "__Host-sahra_p": os.token } })).status).toBe(200);
    const before = { staff_id: newId(), invite_id: newId() };
    expect((await googleInvite(h, owner, before)).status).toBe(200);

    expect((await h.req(`/api/platform/organisers/${o.id}/disable`, papi(so.s))).status).toBe(200);
    expect((await h.req("/api/platform/my-parties", { cookies: { "__Host-sahra_p": os.token } })).status).toBe(401);
    expect((await h.req("/api/platform/parties", papi(os, { id: pid(), name: "x", capacity: 5, staff_id: newId() }))).status).toBe(401);
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": owner.token } })).status).toBe(401);
    expect((await googleInvite(h, owner)).status).toBe(401);
    expect((await h.req("/api/admission", api(owner, { action: "pause" }))).status).toBe(401);
    // Retry of the earlier request (same ids) after the switch-off: refused, not "already".
    expect((await googleInvite(h, owner, before)).status).toBe(401);

    // Statement level: sessions that escaped revocation still cannot act.
    await unrevoke(owner.hash);
    await unrevoke(os.hash, "platform_sessions");
    const now = h.clock.now();
    expect(await db().createGoogleInvite({ hash: owner.hash, partyId: party }, "x", {
      staffId: before.staff_id, inviteId: before.invite_id, name: "New", email: `n-${before.staff_id.slice(0, 8)}@gmail.com`, role: "admin", now, expiresAt: now + 1000, op: newId(),
    })).toBe("rejected");
    const fresh = newId();
    expect(await db().createGoogleInvite({ hash: owner.hash, partyId: party }, "x", {
      staffId: fresh, inviteId: newId(), name: "New", email: "fresh-x@gmail.com", role: "admin", now, expiresAt: now + 1000, op: newId(),
    })).toBe("rejected");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE id = ?").bind(fresh).first("n")).toBe(0);
    expect(await pdb().createParty(os.hash, o.id, { partyId: pid(), name: "x", capacity: 5, staffId: newId(), now, op: newId() })).toBe("forbidden");
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": owner.token } })).status).toBe(401);
    expect((await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": os.token } })).status).toBe(401);
  });

  it("site owner removed: next request refused; a retried invitation (same ids) is refused at the statement too", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const b = await siteOwner(h);
    const ids = { organiser_id: newId(), invite_id: newId(), name: "Org", email: `org-${newId().slice(0, 6)}@gmail.com` };
    expect((await h.req("/api/platform/organisers", papi(b.s, ids))).status).toBe(200);
    expect((await h.req(`/api/platform/site-owners/${b.id}/remove`, papi(a.s))).status).toBe(200);
    expect((await h.req("/api/platform/organisers", { cookies: { "__Host-sahra_p": b.s.token } })).status).toBe(401);
    expect((await h.req("/api/platform/organisers", papi(b.s, ids))).status).toBe(401);
    expect((await h.req(`/api/platform/parties/${await seedParty()}/disable`, papi(b.s))).status).toBe(401);
    await unrevoke(b.s.hash, "platform_sessions");
    const now = h.clock.now();
    expect(await pdb().inviteOrganiser(b.s.hash, b.id, { organiserId: ids.organiser_id, inviteId: ids.invite_id, name: "Org", email: ids.email, now, expiresAt: now + 1000, op: newId() })).toBe("rejected");
    expect(await pdb().disableParty(b.s.hash, b.id, await seedParty(), 1, now, newId())).toBe("rejected");
    expect((await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": b.s.token } })).status).toBe(401);
  });

  it("staff demoted owner -> admin: owner-only actions refused on the very next request, even if the session escaped revocation", async () => {
    const h = await harness();
    const party = await seedParty();
    const x = await seedOwner(party);
    const y = await seedOwner(party);
    const xs = await seedSession(party, x.id, "owner", h.clock);
    const ys = await seedSession(party, y.id, "owner", h.clock);
    const before = { staff_id: newId(), invite_id: newId() };
    expect((await googleInvite(h, xs, before)).status).toBe(200);
    expect((await h.req(`/api/staff/${x.id}/role`, api(ys, { role: "admin" }))).status).toBe(200);
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": xs.token } })).status).toBe(401);
    expect((await googleInvite(h, xs)).status).toBe(401);
    expect((await googleInvite(h, xs, before)).status).toBe(401);
    // The session row says "owner" but the staff row is now admin: no request and no statement accepts it.
    await unrevoke(xs.hash);
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": xs.token } })).status).toBe(401);
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": xs.token } })).status).toBe(401);
    const now = h.clock.now();
    expect(await db().disableStaff({ hash: xs.hash, partyId: party }, x.id, y.id, now, newId())).toBe("rejected");
    expect(await db().changeRole({ hash: xs.hash, partyId: party }, x.id, y.id, "admin", now, newId())).toBe("rejected");
    expect(await env.DB.prepare("SELECT role, disabled_at FROM staff WHERE id = ?").bind(y.id).first()).toEqual({ role: "owner", disabled_at: null });
  });

  it("staff disabled: refused on the very next request, even if the session escaped revocation", async () => {
    const h = await harness();
    const party = await seedParty();
    const x = await seedOwner(party);
    const y = await seedOwner(party);
    const xs = await seedSession(party, x.id, "owner", h.clock);
    const ys = await seedSession(party, y.id, "owner", h.clock);
    expect((await h.req(`/api/staff/${x.id}/disable`, api(ys))).status).toBe(200);
    expect((await googleInvite(h, xs)).status).toBe(401);
    await unrevoke(xs.hash);
    expect((await googleInvite(h, xs)).status).toBe(401);
    const now = h.clock.now();
    const id = newId();
    expect(await db().createDoorInvite({ hash: xs.hash, partyId: party }, x.id, { staffId: id, inviteId: newId(), name: "D", tokenHash: "h".repeat(64), now, expiresAt: now + 1000, op: newId() })).toBe("rejected");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE id = ?").bind(id).first("n")).toBe(0);
  });
});

describe("requests racing the loss of authority: completed before (and logged) or refused, never applied after", () => {
  it("party owner's requests at the same moment as their disable", async () => {
    const h = await harness();
    const party = await seedParty();
    const x = await seedOwner(party);
    const y = await seedOwner(party);
    const xs = await seedSession(party, x.id, "owner", h.clock);
    const ys = await seedSession(party, y.id, "owner", h.clock);
    const ids = Array.from({ length: 6 }, () => ({ staff_id: newId(), invite_id: newId() }));
    const [disable, ...rs] = await Promise.all([
      h.req(`/api/staff/${x.id}/disable`, api(ys)),
      ...ids.map((i) => googleInvite(h, xs, i)),
    ]);
    expect(disable.status).toBe(200);
    const disabledAt = (await auditId("staff_disabled", x.id))!;
    for (const [k, r] of rs.entries()) {
      const row = await env.DB.prepare("SELECT rev, logged_rev FROM staff WHERE id = ?").bind(ids[k]!.staff_id).first<{ rev: number; logged_rev: number }>();
      if (r.status === 200) {
        expect(row!.logged_rev).toBe(row!.rev);
        expect((await auditId("staff_added", ids[k]!.staff_id))!).toBeLessThan(disabledAt);
      } else {
        expect([401, 409]).toContain(r.status);
        expect(row).toBeNull();
      }
    }
    // Retries after the disable, same ids: refused, nothing new.
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE party_id = ?").bind(party).first("n");
    for (const i of ids) expect((await googleInvite(h, xs, i)).status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE party_id = ?").bind(party).first("n")).toBe(n);
  });

  it("organiser's party creations at the same moment as the switch-off", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const { o, os } = await organiserWithParty(h, so, 10);
    const ids = Array.from({ length: 5 }, () => ({ id: pid(), staff_id: newId() }));
    const [off, ...rs] = await Promise.all([
      h.req(`/api/platform/organisers/${o.id}/disable`, papi(so.s)),
      ...ids.map((i) => h.req("/api/platform/parties", papi(os, { ...i, name: `P ${i.id}`, capacity: 5 }))),
    ]);
    expect(off.status).toBe(200);
    for (const [k, r] of rs.entries()) {
      const p = await env.DB.prepare("SELECT logged_rev, rev FROM parties WHERE id = ?").bind(ids[k]!.id).first<{ rev: number; logged_rev: number }>();
      const st = await env.DB.prepare("SELECT disabled_at FROM staff WHERE id = ?").bind(ids[k]!.staff_id).first<{ disabled_at: number | null }>();
      if (r.status === 200) {
        // Created before the switch-off: logged, and the organiser's owner row there was disabled by it.
        expect(p!.logged_rev).toBe(p!.rev);
        expect(st!.disabled_at).not.toBeNull();
      } else {
        expect([401, 403]).toContain(r.status);
        expect(p).toBeNull();
        expect(st).toBeNull();
      }
    }
    // Every staff row the switch-off disabled has an intent (including rows created while it ran).
    const disabled = await env.DB.prepare("SELECT id FROM staff WHERE google_sub = ? AND disabled_at IS NOT NULL").bind(o.sub).all<{ id: string }>();
    for (const s of disabled.results) {
      expect(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM intents WHERE entity = 'staff' AND entity_id = ?").bind(s.id).first("n")).toBe(1);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE google_sub = ? AND disabled_at IS NULL").bind(o.sub).first("n")).toBe(0);
    for (const i of ids) expect((await h.req("/api/platform/parties", papi(os, { ...i, name: `P ${i.id}`, capacity: 5 }))).status).toBe(401);
  });

  it("site owner's invitations at the same moment as their removal", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const b = await siteOwner(h);
    const ids = Array.from({ length: 5 }, () => ({ organiser_id: newId(), invite_id: newId(), name: "Org", email: `race-${newId().slice(0, 8)}@gmail.com` }));
    const [rm, ...rs] = await Promise.all([
      h.req(`/api/platform/site-owners/${b.id}/remove`, papi(a.s)),
      ...ids.map((i) => h.req("/api/platform/organisers", papi(b.s, i))),
    ]);
    expect(rm.status).toBe(200);
    const removedAt = (await env.DB.prepare("SELECT MIN(id) AS id FROM audit WHERE action = 'site_owner_removed' AND entity_id = ?").bind(b.id).first<number>("id"))!;
    for (const [k, r] of rs.entries()) {
      const row = await env.DB.prepare("SELECT rev, logged_rev FROM organisers WHERE id = ?").bind(ids[k]!.organiser_id).first<{ rev: number; logged_rev: number }>();
      if (r.status === 200) {
        expect(row!.logged_rev).toBe(row!.rev);
        expect((await auditId("organiser_invited", ids[k]!.organiser_id))!).toBeLessThan(removedAt);
      } else {
        expect([401, 409]).toContain(r.status);
        expect(row).toBeNull();
      }
    }
    for (const i of ids) expect((await h.req("/api/platform/organisers", papi(b.s, i))).status).toBe(401);
  });
});
