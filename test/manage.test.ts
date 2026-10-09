// Owner decision: a site owner can manage any party. They enter it as an
// ordinary owner (a staff row marked site_owner_id, an ordinary owner session),
// so every party feature and its authority checks apply unchanged.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId } from "../src/lib/crypto";
import {
  api, harness, papi, scan, seedDoor, seedOrganiser, seedOwner, seedParty, seedPlatformSession, seedSession, seedSiteOwner, setCookies,
  testTickets, type Harness,
} from "./helpers";

const pid = () => `pm-${newId().slice(0, 8)}`;

async function siteOwner(h: Harness) {
  const a = await seedSiteOwner();
  return { ...a, s: await seedPlatformSession(a.sub, h.clock) };
}

/** Enters a party as site owner; returns the party session (cookie + CSRF). */
async function manage(h: Harness, so: { s: { token: string; csrf: string } }, party: string) {
  const r = await h.req(`/api/platform/parties/${party}/manage`, papi(so.s));
  const body = (await r.json()) as Record<string, unknown>;
  const ck = setCookies(r)["__Host-sahra_s"];
  if (r.status !== 200 || !ck) return { status: r.status, body, sess: null };
  expect(ck.attrs).toMatch(/HttpOnly/);
  expect(ck.attrs).toMatch(/SameSite=Strict/);
  const me = (await (await h.req("/api/me", { cookies: { "__Host-sahra_s": ck.value } })).json()) as Record<string, any>;
  return { status: 200, body, me, sess: { token: ck.value, csrf: me.csrf as string } };
}

async function organiserParty(h: Harness) {
  const o = await seedOrganiser();
  const os = await seedPlatformSession(o.sub, h.clock);
  const party = pid();
  const staffId = newId();
  expect((await h.req("/api/platform/parties", papi(os, { id: party, name: `Party ${party}`, capacity: 40, staff_id: staffId }))).status).toBe(200);
  return { o, os, party, staffId, owner: await seedSession(party, staffId, "owner", h.clock) };
}

describe("a site owner manages any party", () => {
  it("enters an organiser's party as owner and uses every owner feature; visible and audited in the party", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const { party, owner } = await organiserParty(h);
    const m = await manage(h, so, party);
    expect(m.status).toBe(200);
    expect(m.body).toMatchObject({ status: "managing", party });
    expect(m.me).toMatchObject({ party: { id: party }, staff: { role: "owner" } });
    expect(m.me!.staff.name).toMatch(/\(site owner\)$/);
    const sess = m.sess!;

    // Owner features: staff list and invitations, admission, tickets, scanning.
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": sess.token } })).status).toBe(200);
    expect((await h.req("/api/staff/google-invite", api(sess, { staff_id: newId(), invite_id: newId(), name: "Helper", email: "helper-m@gmail.com", role: "admin" }))).status).toBe(200);
    expect((await h.req("/api/admission", api(sess, { action: "open" }))).status).toBe(200);
    const [t] = await testTickets(h, sess, 1);
    const door = await seedDoor(party, h.clock);
    expect(await scan(h, door, t!.qr)).toMatchObject({ verdict: "admit" });

    // The row is an ordinary logged staff row, marked and audited; the party's own owner sees it.
    const row = await env.DB.prepare("SELECT id, role, site_owner_id, rev, logged_rev, created_by FROM staff WHERE party_id = ? AND site_owner_id IS NOT NULL").bind(party).first<Record<string, unknown>>();
    expect(row).toMatchObject({ role: "owner", site_owner_id: so.id, created_by: so.id });
    expect(row!.logged_rev).toBe(row!.rev);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE party_id = ? AND action = 'site_owner_access'").bind(party).first("n")).toBe(1);
    const list = (await (await h.req("/api/staff", { cookies: { "__Host-sahra_s": owner.token } })).json()) as { staff: { id: string; name: string }[] };
    expect(list.staff.find((x) => x.id === row!.id)!.name).toMatch(/\(site owner\)$/);
    // Changes made while managing carry the site owner's staff row as actor.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE party_id = ? AND actor_staff_id = ? AND action = 'admission_opened'").bind(party, row!.id).first("n")).toBe(1);

    // Entering again reuses the row (no second row, no new audit), new session.
    const again = await manage(h, so, party);
    expect(again.status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE party_id = ? AND site_owner_id IS NOT NULL").bind(party).first("n")).toBe(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE party_id = ? AND action = 'site_owner_access'").bind(party).first("n")).toBe(1);

    // The site owner page counts it separately from the party's own owners.
    const counts = (await (await h.req("/api/platform/parties", { cookies: { "__Host-sahra_p": so.s.token } })).json()) as { parties: Record<string, unknown>[] };
    expect(counts.parties.find((x) => x.id === party)).toMatchObject({ active_owners: 1, site_owners_managing: 1, no_active_owner: false });
  });

  it("does not count as the party's owner: a party without one can still get an owner invitation", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const { o, party } = await organiserParty(h);
    expect((await h.req(`/api/platform/organisers/${o.id}/disable`, papi(so.s))).status).toBe(200);
    expect((await manage(h, so, party)).status).toBe(200);
    const counts = (await (await h.req("/api/platform/parties", { cookies: { "__Host-sahra_p": so.s.token } })).json()) as { parties: Record<string, unknown>[] };
    expect(counts.parties.find((x) => x.id === party)).toMatchObject({ no_active_owner: true, site_owners_managing: 1 });
    const body = { staff_id: newId(), invite_id: newId(), name: "Owner", email: "owner-after@gmail.com" };
    expect((await h.req(`/api/platform/parties/${party}/owner-invite`, papi(so.s, body))).status).toBe(200);
  });

  it("only site owners; refused for a disabled or unknown party", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const { os, owner, party } = await organiserParty(h);
    expect((await h.req(`/api/platform/parties/${party}/manage`, papi(os))).status).toBe(403);
    expect((await h.req(`/api/platform/parties/${party}/manage`, api(owner))).status).toBe(401);
    expect((await h.req(`/api/platform/parties/no-such-party/manage`, papi(so.s))).status).toBe(404);
    const other = await seedParty();
    expect((await h.req(`/api/platform/parties/${other}/disable`, papi(so.s))).status).toBe(200);
    expect(await (await h.req(`/api/platform/parties/${other}/manage`, papi(so.s))).json()).toEqual({ error: "party_disabled" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE party_id = ? AND site_owner_id IS NOT NULL").bind(other).first("n")).toBe(0);
  });

  it("the party's own owner can remove the site owner's row; entering again restores it (audited)", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const { party, owner } = await organiserParty(h);
    const m = await manage(h, so, party);
    const rowId = (await env.DB.prepare("SELECT id FROM staff WHERE party_id = ? AND site_owner_id = ?").bind(party, so.id).first<{ id: string }>())!.id;
    expect((await h.req(`/api/staff/${rowId}/disable`, api(owner))).status).toBe(200);
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": m.sess!.token } })).status).toBe(401);
    expect((await manage(h, so, party)).status).toBe(200);
    expect(await env.DB.prepare("SELECT disabled_at FROM staff WHERE id = ?").bind(rowId).first("disabled_at")).toBeNull();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE entity_id = ? AND action = 'site_owner_access'").bind(rowId).first("n")).toBe(2);
  });

  it("an existing staff row of the same Google account becomes the managing owner row", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const party = await seedParty();
    await seedOwner(party);
    const door = await env.DB.prepare("INSERT INTO staff (id, party_id, name, role, google_sub, created_at, logged_rev) VALUES (?, ?, 'Me', 'admin', ?, 0, 1)")
      .bind(newId(), party, so.sub).run();
    expect(door.meta.changes).toBe(1);
    const m = await manage(h, so, party);
    expect(m.me).toMatchObject({ staff: { role: "owner" } });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM staff WHERE party_id = ? AND google_sub = ?").bind(party, so.sub).first("n")).toBe(1);
  });

  it("removing the site owner ends their access to every party they manage, on the next request", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const b = await siteOwner(h);
    const p1 = (await organiserParty(h)).party;
    const p2 = await seedParty();
    await seedOwner(p2);
    const m1 = await manage(h, b, p1);
    const m2 = await manage(h, b, p2);
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": m1.sess!.token } })).status).toBe(200);
    const r = await h.req(`/api/platform/site-owners/${b.id}/remove`, papi(a.s));
    expect(await r.json()).toEqual({ status: "removed", staff_disabled: 2 });
    for (const m of [m1, m2]) {
      expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": m.sess!.token } })).status).toBe(401);
      expect((await h.req("/api/admission", api(m.sess!, { action: "pause" }))).status).toBe(401);
    }
    const rows = await env.DB.prepare("SELECT id, party_id, disabled_at FROM staff WHERE site_owner_id = ?").bind(b.id).all<{ id: string; party_id: string; disabled_at: number | null }>();
    expect(rows.results).toHaveLength(2);
    for (const x of rows.results) {
      expect(x.disabled_at).not.toBeNull();
      expect(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM intents WHERE entity = 'staff' AND entity_id = ? AND party_id = ?").bind(x.id, x.party_id).first("n")).toBe(1);
    }
    // Escaped session (artificially un-revoked): the staff row is disabled, so still refused.
    await env.DB.prepare("UPDATE sessions SET revoked_at = NULL WHERE party_id = ? AND staff_id = ?").bind(p1, rows.results.find((x) => x.party_id === p1)!.id).run();
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": m1.sess!.token } })).status).toBe(401);
  });

  it("the hourly session cap applies", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const party = await seedParty();
    await seedOwner(party);
    for (let i = 0; i < 10; i++) expect((await manage(h, so, party)).status).toBe(200);
    expect((await manage(h, so, party)).status).toBe(429);
  });

  it("change log unreachable: no session is handed out; a retry completes", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const party = await seedParty();
    await seedOwner(party);
    h.ledger.mode = "fail";
    const r = await h.req(`/api/platform/parties/${party}/manage`, papi(so.s));
    expect(r.status).toBe(503);
    expect(setCookies(r)["__Host-sahra_s"]).toBeUndefined();
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE party_id = ?").bind(party).first("n")).toBe(0);
    h.ledger.mode = "ok";
    expect((await manage(h, so, party)).status).toBe(200);
  });
});
