import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { newId, newToken } from "../src/lib/crypto";
import { DEFAULT_PARTY_LIMIT, PlatformDb } from "../src/platform/db";
import { D1Driver } from "../src/db/driver";
import { siteOwnerSql } from "../scripts/site-owner-sql.mjs";
import {
  api, googleLogin, harness, logEntry, OutageDriver, openParty, ORIGIN, papi, platformLogin, scan, seedOrganiser, seedOwner,
  seedParty, seedSiteOwner, seedPlatformSession, seedSession, setCookies, testTickets, type Harness,
} from "./helpers";

afterEach(() => { OutageDriver.down = { main: false, ledger: false }; });

const DUMP = false; // true prints the measured rows (as a failure message)
const pid = () => `pt-${newId().slice(0, 8)}`;

async function siteOwner(h: Harness) {
  const a = await seedSiteOwner();
  return { ...a, s: await seedPlatformSession(a.sub, h.clock) };
}

async function organiser(h: Harness) {
  const o = await seedOrganiser();
  return { ...o, s: await seedPlatformSession(o.sub, h.clock) };
}

async function inviteOrganiser(h: Harness, as: { token: string; csrf: string }, email: string, name = "Org") {
  const body = { organiser_id: newId(), invite_id: newId(), name, email };
  const r = await h.req("/api/platform/organisers", papi(as, body));
  return { r, body };
}

function createParty(h: Harness, os: { token: string; csrf: string }, id = pid(), staffId = newId()) {
  return h.req("/api/platform/parties", papi(os, { id, name: `Party ${id}`, capacity: 120, staff_id: staffId }));
}

describe("site owner bootstrap and sign-in", () => {
  it("the ops step's SQL adds an admin once; the first platform sign-in links it and sets a Strict __Host- cookie", async () => {
    const h = await harness();
    const now = h.clock.now();
    const run = async () => {
      const { statements, email } = siteOwnerSql({ name: "Owner", email: "Boot.Strap+x@gmail.com", id: newId(), op: newId(), now });
      await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
      return email;
    };
    const email = await run();
    expect(email).toBe("bootstrap@gmail.com");
    await run(); // again: not duplicated (renews the sign-in window only)
    const rows = await env.DB.prepare("SELECT id, rev, google_sub FROM platform_admins WHERE email = ?").bind(email).all<{ id: string; rev: number }>();
    expect(rows.results).toHaveLength(1);
    expect(rows.results[0]!.rev).toBe(2);
    expect(() => siteOwnerSql({ name: "x", email: "not-an-email", id: newId(), op: newId(), now })).toThrow();

    h.google.identity = { sub: "boot-sub", email: "bootstrap@gmail.com", email_verified: true };
    const { res, cookies, html } = await platformLogin(h);
    expect(res.status).toBe(200);
    expect(html).toContain("/platform");
    const ck = cookies["__Host-sahra_p"]!;
    expect(ck.attrs).toMatch(/HttpOnly/);
    expect(ck.attrs).toMatch(/Secure/);
    expect(ck.attrs).toMatch(/SameSite=Strict/);
    expect(cookies["__Host-sahra_s"]).toBeUndefined();
    const row = await env.DB.prepare("SELECT google_sub, rev, logged_rev FROM platform_admins WHERE email = ?").bind(email).first();
    expect(row).toMatchObject({ google_sub: "boot-sub", rev: 3, logged_rev: 3 });
    const id = rows.results[0]!.id;
    expect(((await logEntry("platform_admin", id, 3)) as Record<string, unknown>).party_id).toBe("_platform");

    const me = await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": ck.value } });
    expect(await me.json()).toMatchObject({ site_owner: { id }, organiser: null });
    // Only the session hash is stored.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_sessions WHERE id_hash = ?").bind(ck.value).first("n")).toBe(0);
  });

  it("an expired bootstrap row does not link", async () => {
    const h = await harness();
    const { statements } = siteOwnerSql({ name: "Late", email: "late-admin@gmail.com", id: newId(), op: newId(), now: h.clock.now() - 15 * 86400_000 });
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    h.google.identity = { sub: "late-sub", email: "late-admin@gmail.com" };
    const { res } = await platformLogin(h);
    expect(res.status).toBe(403);
  });

  it("platform sessions are capped per Google account per hour (read-only check)", async () => {
    const h = await harness();
    const a = await seedSiteOwner("cap-sub");
    for (let i = 0; i < 10; i++) await seedPlatformSession(a.sub, h.clock);
    h.google.identity = { sub: "cap-sub", email: "cap-sub@gmail.com" };
    const { res, cookies } = await platformLogin(h);
    expect(res.status).toBe(429);
    expect(cookies["__Host-sahra_p"]).toBeUndefined();
    h.clock.advance(3601_000);
    expect((await platformLogin(h)).res.status).toBe(200);
  });

  it("a staff sign-in attempt cannot be turned into a platform sign-in (sealed attempt), and the other way round", async () => {
    const h = await harness();
    const a = await seedSiteOwner("only-admin");
    h.google.identity = { sub: a.sub, email: `${a.sub}@gmail.com` };
    // Staff flow for a site owner who is not party staff: no access, no platform cookie.
    const staff = await googleLogin(h);
    expect(staff.res.status).toBe(403);
    expect(staff.cookies["__Host-sahra_p"]).toBeUndefined();
    expect(staff.cookies["__Host-sahra_s"]).toBeUndefined();
  });
});

describe("organisers by invitation", () => {
  it("admin invites; the organiser's first Gmail sign-in links them; retry is recognized; duplicates refused", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const { r, body } = await inviteOrganiser(h, a.s, "Nour.Org@gmail.com");
    expect(await r.json()).toEqual({ status: "created", email: "nourorg@gmail.com" });
    expect(await (await h.req("/api/platform/organisers", papi(a.s, body))).json()).toEqual({ status: "already", email: "nourorg@gmail.com" });
    const dup = await inviteOrganiser(h, a.s, "nourorg@gmail.com");
    expect(dup.r.status).toBe(409);
    expect(await logEntry("organiser", body.organiser_id, 1)).not.toBeNull();
    expect(await logEntry("organiser_invite", body.invite_id, 1)).not.toBeNull();

    h.google.identity = { sub: "nour-sub", email: "nour.org@gmail.com" };
    const { res, cookies } = await platformLogin(h);
    expect(res.status).toBe(200);
    const o = await env.DB.prepare("SELECT google_sub, rev, logged_rev FROM organisers WHERE id = ?").bind(body.organiser_id).first();
    expect(o).toMatchObject({ google_sub: "nour-sub", rev: 2, logged_rev: 2 });
    const inv = await env.DB.prepare("SELECT used_at, rev, logged_rev FROM organiser_invites WHERE id = ?").bind(body.invite_id).first();
    expect(inv).toMatchObject({ rev: 2, logged_rev: 2 });
    expect(inv!.used_at).not.toBeNull();
    const me = await (await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": cookies["__Host-sahra_p"]!.value } })).json();
    expect(me).toMatchObject({ site_owner: null, organiser: { id: body.organiser_id } });

    const list = (await (await h.req("/api/platform/organisers", { cookies: { "__Host-sahra_p": a.s.token } })).json()) as { organisers: { id: string; linked: number }[] };
    expect(list.organisers.find((x) => x.id === body.organiser_id)).toMatchObject({ linked: 1 });
  });

  it("one invitation consumed twice at once gives exactly one organiser link", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const { body } = await inviteOrganiser(h, a.s, "race-org@gmail.com");
    // Two different Google accounts presenting the same address at the same moment
    // (the strongest form of the race): only one link, one invitation use.
    const pdb = new PlatformDb(new D1Driver(env.DB));
    const now = h.clock.now();
    const results = await Promise.all([
      pdb.link("race-a", "race-org@gmail.com", now, newId()),
      pdb.link("race-b", "race-org@gmail.com", now, newId()),
      pdb.link("race-a", "race-org@gmail.com", now, newId()),
    ]);
    expect(results.reduce((x, y) => x + y, 0)).toBe(1);
    const o = await env.DB.prepare("SELECT google_sub, rev FROM organisers WHERE id = ?").bind(body.organiser_id).first<{ google_sub: string; rev: number }>();
    expect(o!.rev).toBe(2);
    expect(await env.DB.prepare("SELECT rev FROM organiser_invites WHERE id = ?").bind(body.invite_id).first("rev")).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'organiser_linked' AND entity_id = ?").bind(body.organiser_id).first("n")).toBe(1);

    // The same person signing in again later: no second link.
    const h2 = await harness();
    const b2 = (await inviteOrganiser(h2, a.s, "race-two@gmail.com")).body;
    h2.google.identity = { sub: "race-two", email: "race-two@gmail.com" };
    expect((await platformLogin(h2)).res.status).toBe(200);
    expect((await platformLogin(h2)).res.status).toBe(200);
    expect(await env.DB.prepare("SELECT rev FROM organisers WHERE id = ?").bind(b2.organiser_id).first("rev")).toBe(2);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'organiser_linked' AND entity_id = ?").bind(b2.organiser_id).first("n")).toBe(1);
  });

  it("an address that is not Gmail or Workspace cannot auto-link; Workspace with a matching hd can; unverified cannot", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const other = (await inviteOrganiser(h, a.s, "someone@example.org")).body;
    h.google.identity = { sub: "ex-sub", email: "someone@example.org", email_verified: true };
    const r = await platformLogin(h);
    expect(r.res.status).toBe(403);
    expect(r.html).toContain("Confirmation needed");
    expect(r.cookies["__Host-sahra_p"]).toBeUndefined();
    expect(await env.DB.prepare("SELECT google_sub FROM organisers WHERE id = ?").bind(other.organiser_id).first("google_sub")).toBeNull();
    // A hd claim for another domain does not help.
    h.google.identity = { sub: "ex-sub", email: "someone@example.org", hd: "evil.example" };
    expect((await platformLogin(h)).res.status).toBe(403);

    const unverified = (await inviteOrganiser(h, a.s, "unverified-org@gmail.com")).body;
    h.google.identity = { sub: "unv-sub", email: "unverified-org@gmail.com", email_verified: false };
    expect((await platformLogin(h)).res.status).toBe(403);
    expect(await env.DB.prepare("SELECT google_sub FROM organisers WHERE id = ?").bind(unverified.organiser_id).first("google_sub")).toBeNull();

    const ws = (await inviteOrganiser(h, a.s, "lead@company.example")).body;
    h.google.identity = { sub: "ws-sub", email: "lead@company.example", hd: "company.example" };
    expect((await platformLogin(h)).res.status).toBe(200);
    expect(await env.DB.prepare("SELECT google_sub FROM organisers WHERE id = ?").bind(ws.organiser_id).first("google_sub")).toBe("ws-sub");
    // Afterwards by Google account id only: a changed email still signs in.
    h.google.identity = { sub: "ws-sub", email: "renamed@company.example", hd: "company.example" };
    expect((await platformLogin(h)).res.status).toBe(200);
  });

  it("a verified Google account that is not invited gets no access and no platform session", async () => {
    const h = await harness();
    h.google.identity = { sub: `x-${newId()}`, email: "nobody-special@gmail.com" };
    const r = await platformLogin(h);
    expect(r.res.status).toBe(403);
    expect(r.cookies["__Host-sahra_p"]).toBeUndefined();
  });
});

describe("party creation by organisers", () => {
  it("an organiser creates a party in one batch, becomes its owner, and signs in to it like any staff member", async () => {
    const h = await harness();
    const o = await organiser(h);
    const id = pid();
    const staffId = newId();
    const r = await createParty(h, o.s, id, staffId);
    expect(await r.json()).toEqual({ status: "created", party: { id, name: `Party ${id}` } });
    // Retry with the same body: recognized, nothing duplicated.
    expect(await (await createParty(h, o.s, id, staffId)).json()).toMatchObject({ status: "already" });
    const p = await env.DB.prepare("SELECT organiser_id, capacity, rev, logged_rev, disabled_at FROM parties WHERE id = ?").bind(id).first();
    expect(p).toMatchObject({ organiser_id: o.id, capacity: 120, rev: 1, logged_rev: 1, disabled_at: null });
    const st = await env.DB.prepare("SELECT role, google_sub, logged_rev FROM staff WHERE id = ?").bind(staffId).first();
    expect(st).toMatchObject({ role: "owner", google_sub: o.sub, logged_rev: 1 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE party_id = ? AND action IN ('party_created', 'staff_added')").bind(id).first("n")).toBe(2);
    expect(await logEntry("party", id, 1)).not.toBeNull();
    expect(await logEntry("staff", staffId, 1)).not.toBeNull();

    // Staff sign-in with the same Google account lands in the new party as owner.
    h.google.identity = { sub: o.sub, email: `${o.sub}@gmail.com` };
    const login = await googleLogin(h);
    expect(login.res.status).toBe(200);
    const me = await (await h.req("/api/me", { cookies: { "__Host-sahra_s": login.cookies["__Host-sahra_s"]!.value } })).json();
    expect(me).toMatchObject({ party: { id }, staff: { id: staffId, role: "owner" } });

    const mine = (await (await h.req("/api/platform/my-parties", { cookies: { "__Host-sahra_p": o.s.token } })).json()) as { parties: { id: string }[] };
    expect(mine.parties.map((x) => x.id)).toEqual([id]);
    // Someone else's id is taken.
    const o2 = await organiser(h);
    expect(await (await createParty(h, o2.s, id)).json()).toEqual({ error: "party_id_taken" });
  });

  it("only organisers can create parties: site owners, party staff and strangers cannot", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    expect((await createParty(h, a.s)).status).toBe(403);
    const party = await seedParty();
    const owner = await seedOwner(party);
    const ss = await seedSession(party, owner.id, "owner", h.clock);
    // A party staff session, sent as a platform cookie or as itself.
    expect((await createParty(h, ss)).status).toBe(401);
    expect((await h.req("/api/platform/parties", api(ss, { id: pid(), name: "x", capacity: 1, staff_id: newId() }))).status).toBe(401);
    expect((await h.req("/api/platform/parties", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: "{}" })).status).toBe(401);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM parties WHERE organiser_id IS NOT NULL AND organiser_id = ?").bind(a.id).first("n")).toBe(0);
    // Reserved and malformed ids.
    const o = await organiser(h);
    for (const bad of ["_platform", "AB", "x", "a_b_c"]) expect((await createParty(h, o.s, bad)).status).toBe(400);
  });

  it("party limit: 1 active party by default, a site owner raises it, inside the statement (even at once); disabled parties do not count", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const o = await organiser(h);
    const burst = async (n: number) => (await Promise.all(Array.from({ length: n }, () => createParty(h, o.s)))).map((r) => r.status);
    let st = await burst(4);
    expect(st.filter((s) => s === 200)).toHaveLength(DEFAULT_PARTY_LIMIT);
    expect(await (await createParty(h, o.s)).json()).toEqual({ error: "party_limit_reached" });

    // Only a site owner sets the limit, 1..20.
    expect((await h.req(`/api/platform/organisers/${o.id}/party-limit`, papi(o.s, { limit: 3 }))).status).toBe(403);
    for (const bad of [0, 21, 2.5, "3"]) expect((await h.req(`/api/platform/organisers/${o.id}/party-limit`, papi(so.s, { limit: bad }))).status).toBe(400);
    expect((await h.req(`/api/platform/organisers/${newId()}/party-limit`, papi(so.s, { limit: 3 }))).status).toBe(404);
    const r = await h.req(`/api/platform/organisers/${o.id}/party-limit`, papi(so.s, { limit: 3 }));
    expect(await r.json()).toEqual({ status: "changed", party_limit: 3 });
    expect(await (await h.req(`/api/platform/organisers/${o.id}/party-limit`, papi(so.s, { limit: 3 }))).json()).toMatchObject({ status: "already" });
    expect((await logEntry("organiser", o.id, 2))!.state).toMatchObject({ party_limit: 3, last_action: "party_limit_changed" });
    expect(await env.DB.prepare("SELECT detail FROM audit WHERE action = 'party_limit_changed' AND entity_id = ?").bind(o.id).first("detail")).toBe("3");

    st = await burst(5);
    expect(st.filter((s) => s === 200)).toHaveLength(2);
    const active = () => env.DB.prepare("SELECT COUNT(*) AS n FROM parties WHERE organiser_id = ? AND disabled_at IS NULL").bind(o.id).first("n");
    expect(await active()).toBe(3);

    // A disabled party frees a place.
    const one = await env.DB.prepare("SELECT id FROM parties WHERE organiser_id = ? LIMIT 1").bind(o.id).first<{ id: string }>();
    expect((await h.req(`/api/platform/parties/${one!.id}/disable`, papi(so.s))).status).toBe(200);
    expect((await createParty(h, o.s)).status).toBe(200);
    expect(await active()).toBe(3);
    // Lowering below the current count blocks new parties, nothing else.
    expect((await h.req(`/api/platform/organisers/${o.id}/party-limit`, papi(so.s, { limit: 1 }))).status).toBe(200);
    expect(await (await createParty(h, o.s)).json()).toEqual({ error: "party_limit_reached" });
    expect(await active()).toBe(3);
    const list = (await (await h.req("/api/platform/organisers", { cookies: { "__Host-sahra_p": so.s.token } })).json()) as { organisers: Record<string, unknown>[] };
    expect(list.organisers.find((x) => x.id === o.id)).toMatchObject({ party_limit: 1, active_parties: 3, parties: 4 });
  });

  it("platform routes reject party staff sessions, and party routes reject platform sessions", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const party = await seedParty();
    const owner = await seedOwner(party);
    const ss = await seedSession(party, owner.id, "owner", h.clock);
    // Staff token in the platform cookie.
    expect((await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": ss.token } })).status).toBe(401);
    expect((await h.req("/api/platform/parties", { cookies: { "__Host-sahra_p": ss.token } })).status).toBe(401);
    // Staff cookie on a platform route.
    expect((await h.req("/api/platform/parties", { cookies: { "__Host-sahra_s": ss.token } })).status).toBe(401);
    // Platform token on party routes, in either cookie.
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": a.s.token } })).status).toBe(401);
    expect((await h.req("/api/staff", { cookies: { "__Host-sahra_s": a.s.token } })).status).toBe(401);
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_p": a.s.token } })).status).toBe(401);
    // An organiser is not a site owner.
    const o = await organiser(h);
    expect((await h.req("/api/platform/parties", { cookies: { "__Host-sahra_p": o.s.token } })).status).toBe(403);
    expect((await h.req(`/api/platform/parties/${party}/disable`, papi(o.s))).status).toBe(403);
  });

  it("platform changes need our Origin and the session's CSRF token", async () => {
    const h = await harness();
    const o = await organiser(h);
    const body = { id: pid(), name: "x", capacity: 5, staff_id: newId() };
    const noCsrf = papi(o.s, body);
    delete (noCsrf.headers as Record<string, string>)["x-sahra-csrf"];
    expect((await h.req("/api/platform/parties", noCsrf)).status).toBe(403);
    const cross = papi(o.s, body);
    (cross.headers as Record<string, string>).origin = "https://evil.example";
    expect((await h.req("/api/platform/parties", cross)).status).toBe(403);
    expect((await h.req("/api/platform/parties", papi(o.s, body))).status).toBe(200);
  });
});

describe("disabling", () => {
  it("disabled party: control object paused first (pause_number + 1), scans answer paused, sessions and invitations end, sign-in and join refused", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const { party, owner, os } = await openParty(h);
    const door = await (await import("./helpers")).seedDoor(party, h.clock);
    const [t] = await testTickets(h, os, 2);
    // A door invitation not used yet.
    const doorToken = newToken();
    expect((await h.req("/api/staff/door-invite", api(os, { staff_id: newId(), invite_id: newId(), name: "Late", token: doorToken }))).status).toBe(200);
    const before = (await h.ledger.getControl(party))!;

    const r = await h.req(`/api/platform/parties/${party}/disable`, papi(a.s));
    expect(await r.json()).toEqual({ status: "disabled", pause_number: before.pause_number + 1 });
    const control = (await h.ledger.getControl(party))!;
    expect(control).toMatchObject({ state: "paused", pause_number: before.pause_number + 1, rev: before.rev + 1 });
    const p = await env.DB.prepare("SELECT disabled_at, admission_state, pause_number, rev, logged_rev FROM parties WHERE id = ?").bind(party).first();
    expect(p).toMatchObject({ admission_state: "paused", pause_number: before.pause_number + 1 });
    expect(p!.disabled_at).not.toBeNull();
    expect(p!.logged_rev).toBe(p!.rev);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE party_id = ? AND revoked_at IS NULL").bind(party).first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM invites WHERE party_id = ? AND used_at IS NULL AND revoked_at IS NULL").bind(party).first("n")).toBe(0);
    // Intent recorded before the change.
    expect(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM intents WHERE party_id = ? AND action = 'party_disabled'").bind(party).first("n")).toBe(1);

    // Scan: the paused control object answers first.
    expect(await scan(h, door, t!.qr)).toEqual({ verdict: "paused" });
    expect(await env.DB.prepare("SELECT used_scan_id FROM tickets WHERE id = ?").bind(t!.id).first("used_scan_id")).toBeNull();
    // Old sessions are gone.
    expect((await h.req("/api/me", { cookies: { "__Host-sahra_s": os.token } })).status).toBe(401);
    // Staff Google sign-in refused.
    h.google.identity = { sub: owner.sub, email: `${owner.sub}@gmail.com` };
    const login = await googleLogin(h);
    expect(login.res.status).toBe(403);
    expect(login.cookies["__Host-sahra_s"]).toBeUndefined();
    // Door join refused.
    const join = await h.req("/api/invites/consume", {
      method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
      body: JSON.stringify({ token: doorToken, session: newToken() }),
    });
    expect(join.status).toBe(410);

    // Again: "already", nothing new paused.
    expect(await (await h.req(`/api/platform/parties/${party}/disable`, papi(a.s))).json()).toMatchObject({ status: "already" });
    expect((await h.ledger.getControl(party))!.rev).toBe(control.rev);
    const counts = (await (await h.req("/api/platform/parties", { cookies: { "__Host-sahra_p": a.s.token } })).json()) as { parties: Record<string, unknown>[] };
    const mine = counts.parties.find((x) => x.id === party)!;
    expect(mine).toMatchObject({ tickets: { approved: 2 }, active_sessions: 0 });
    expect(mine.disabled_at).not.toBeNull();
    expect(JSON.stringify(counts)).not.toContain("Guest");
  });

  it("disabled party: staff sign-in refused even for a session-less owner (the party picker skips it)", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const p1 = await seedParty();
    const p2 = await seedParty();
    const sub = `multi-${newId()}`;
    await seedOwner(p1, sub);
    await seedOwner(p2, sub);
    expect((await h.req(`/api/platform/parties/${p1}/disable`, papi(a.s))).status).toBe(200);
    h.google.identity = { sub, email: `${sub}@gmail.com` };
    const login = await googleLogin(h);
    // Only one party left: straight in, to p2.
    expect(login.res.status).toBe(200);
    const me = await (await h.req("/api/me", { cookies: { "__Host-sahra_s": login.cookies["__Host-sahra_s"]!.value } })).json();
    expect(me).toMatchObject({ party: { id: p2 } });
  });

  it("disabled organiser: platform sessions end, sign-in refused, cannot create parties", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const o = await organiser(h);
    const second = await seedPlatformSession(o.sub, h.clock);
    expect((await createParty(h, o.s)).status).toBe(200);
    const r = await h.req(`/api/platform/organisers/${o.id}/disable`, papi(a.s));
    expect(await r.json()).toEqual({ status: "disabled", staff_disabled: 1 });
    expect(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM intents WHERE entity = 'organiser' AND entity_id = ?").bind(o.id).first("n")).toBe(1);
    expect((await logEntry("organiser", o.id, 2))!.state).toMatchObject({ last_action: "organiser_disabled" });
    for (const s of [o.s, second]) {
      expect((await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": s.token } })).status).toBe(401);
      expect((await createParty(h, s)).status).toBe(401);
    }
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_sessions WHERE google_sub = ? AND revoked_at IS NULL").bind(o.sub).first("n")).toBe(0);
    h.google.identity = { sub: o.sub, email: `${o.sub}@gmail.com` };
    expect((await platformLogin(h)).res.status).toBe(403);
    expect(await (await h.req(`/api/platform/organisers/${o.id}/disable`, papi(a.s))).json()).toMatchObject({ status: "already" });
    // A session of a removed site owner does nothing either.
    await env.DB.prepare("UPDATE platform_admins SET disabled_at = 1 WHERE id = ?").bind(a.id).run();
    expect((await h.req(`/api/platform/organisers/${o.id}/disable`, papi(a.s))).status).toBe(401);
  });

  it("an invitation for a disabled organiser can no longer be used", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const { body } = await inviteOrganiser(h, a.s, "gone-org@gmail.com");
    expect((await h.req(`/api/platform/organisers/${body.organiser_id}/disable`, papi(a.s))).status).toBe(200);
    expect(await env.DB.prepare("SELECT revoked_at IS NOT NULL AS r FROM organiser_invites WHERE id = ?").bind(body.invite_id).first("r")).toBe(1);
    h.google.identity = { sub: "gone-sub", email: "gone-org@gmail.com" };
    expect((await platformLogin(h)).res.status).toBe(403);
    // Re-inviting the same address is allowed once the old row is disabled.
    expect((await inviteOrganiser(h, a.s, "gone-org@gmail.com")).r.status).toBe(200);
    expect((await platformLogin(h)).res.status).toBe(200);
  });
});

describe("failures: nothing confirmed, a retry completes", () => {
  it("ledger unreachable: disabling a party is not made (intent not written); a retry makes it", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const party = await seedParty();
    h.ledger.intentMode = "fail";
    const r = await h.req(`/api/platform/parties/${party}/disable`, papi(a.s));
    expect(r.status).toBe(503);
    expect(await r.json()).toMatchObject({ status: "pending", retry: true });
    expect(await env.DB.prepare("SELECT disabled_at FROM parties WHERE id = ?").bind(party).first("disabled_at")).toBeNull();
    expect(await h.ledger.getControl(party)).toBeNull();
    h.ledger.intentMode = "ok";
    expect(await (await h.req(`/api/platform/parties/${party}/disable`, papi(a.s))).json()).toMatchObject({ status: "disabled" });
  });

  it("change log unreachable after the main batch: pending; the retry records it and answers already", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const party = await seedParty();
    h.ledger.mode = "fail";
    expect((await h.req(`/api/platform/parties/${party}/disable`, papi(a.s))).status).toBe(503);
    const p = await env.DB.prepare("SELECT rev, logged_rev FROM parties WHERE id = ?").bind(party).first<{ rev: number; logged_rev: number }>();
    expect(p!.logged_rev).toBeLessThan(p!.rev);
    h.ledger.mode = "ok";
    expect(await (await h.req(`/api/platform/parties/${party}/disable`, papi(a.s))).json()).toMatchObject({ status: "already" });
    const p2 = await env.DB.prepare("SELECT rev, logged_rev FROM parties WHERE id = ?").bind(party).first<{ rev: number; logged_rev: number }>();
    expect(p2!.logged_rev).toBe(p2!.rev);

    // Organiser invitation and party creation: the same pattern.
    h.ledger.mode = "fail";
    const inv = await inviteOrganiser(h, a.s, "pending-org@gmail.com");
    expect(inv.r.status).toBe(503);
    h.ledger.mode = "ok";
    expect(await (await h.req("/api/platform/organisers", papi(a.s, inv.body))).json()).toMatchObject({ status: "already" });
    expect(await logEntry("organiser", inv.body.organiser_id, 1)).not.toBeNull();

    const o = await organiser(h);
    const id = pid();
    const staffId = newId();
    h.ledger.mode = "lose_ack";
    expect((await createParty(h, o.s, id, staffId)).status).toBe(503);
    h.ledger.mode = "ok";
    expect(await (await createParty(h, o.s, id, staffId)).json()).toMatchObject({ status: "already" });
    expect(await env.DB.prepare("SELECT logged_rev FROM staff WHERE id = ?").bind(staffId).first("logged_rev")).toBe(1);

    // Disabling an organiser with the intent write failing: not made.
    h.ledger.intentMode = "fail";
    expect((await h.req(`/api/platform/organisers/${o.id}/disable`, papi(a.s))).status).toBe(503);
    expect(await env.DB.prepare("SELECT disabled_at FROM organisers WHERE id = ?").bind(o.id).first("disabled_at")).toBeNull();
    h.ledger.intentMode = "ok";
  });

  it("platform sign-in whose change log write fails gives no session; the next sign-in completes it", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const { body } = await inviteOrganiser(h, a.s, "flaky-org@gmail.com");
    h.google.identity = { sub: "flaky-sub", email: "flaky-org@gmail.com" };
    h.ledger.mode = "fail";
    const r = await platformLogin(h);
    expect(r.res.status).toBe(503);
    expect(r.cookies["__Host-sahra_p"]).toBeUndefined();
    h.ledger.mode = "ok";
    expect((await platformLogin(h)).res.status).toBe(200);
    expect(await env.DB.prepare("SELECT logged_rev FROM organisers WHERE id = ?").bind(body.organiser_id).first("logged_rev")).toBe(2);
  });

  it("main database unreachable: platform routes answer 503 and nothing is confirmed", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const party = await seedParty();
    OutageDriver.down.main = true;
    expect((await h.req(`/api/platform/parties/${party}/disable`, papi(a.s))).status).toBe(503);
    expect((await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": a.s.token } })).status).toBe(503);
    OutageDriver.down.main = false;
    expect(await env.DB.prepare("SELECT disabled_at FROM parties WHERE id = ?").bind(party).first("disabled_at")).toBeNull();
    expect((await h.req(`/api/platform/parties/${party}/disable`, papi(a.s))).status).toBe(200);
  });
});

describe("cookies", () => {
  it("logout ends only the platform session", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const r = await h.req("/api/platform/logout", papi(a.s));
    expect(r.status).toBe(200);
    expect(setCookies(r)["__Host-sahra_p"]!.attrs).toMatch(/Max-Age=0/);
    expect((await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": a.s.token } })).status).toBe(401);
  });
});

describe("rows per request (measured locally)", () => {
  it("records main/ledger rows for each platform request", async () => {
    const { vi } = await import("vitest");
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...x: unknown[]) => { logs.push(String(x[0])); });
    const last = () => JSON.parse(logs.filter((l) => l.startsWith('{"evt":"req"')).at(-1)!) as Record<string, number | string>;
    const out: Record<string, unknown> = {};
    const note = (label: string) => {
      const m = last();
      out[label] = { status: m.status, queries: m.d1_queries, rows_read: m.rows_read, rows_written: m.rows_written, ledger_rows_written: m.ledger_rows_written };
    };
    try {
      const h = await harness();
      const a = await siteOwner(h);
      await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": a.s.token } }); note("GET /api/platform/me");
      const { body } = await inviteOrganiser(h, a.s, "measure-org@gmail.com"); note("POST /api/platform/organisers (invite)");
      await h.req("/api/auth/platform/start", { method: "POST", headers: { origin: ORIGIN } }); note("POST /api/auth/platform/start");
      h.google.identity = { sub: "measure-sub", email: "measure-org@gmail.com" };
      await platformLogin(h); note("callback, first sign-in (links organiser + invite)");
      const again = await platformLogin(h); note("callback, later sign-in");
      const os = { token: again.cookies["__Host-sahra_p"]!.value, csrf: ((await (await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": again.cookies["__Host-sahra_p"]!.value } })).json()) as { csrf: string }).csrf };
      const id = pid();
      await createParty(h, os, id); note("POST /api/platform/parties (create)");
      await h.req("/api/platform/my-parties", { cookies: { "__Host-sahra_p": os.token } }); note("GET /api/platform/my-parties");
      await h.req("/api/platform/parties", { cookies: { "__Host-sahra_p": a.s.token } }); note("GET /api/platform/parties (counts, whole test database)");
      await h.req(`/api/platform/parties/${id}/disable`, papi(a.s)); note("POST /api/platform/parties/:id/disable (no sessions/invites)");
      await h.req(`/api/platform/parties/${id}/enable`, papi(a.s)); note("POST /api/platform/parties/:id/enable");
      await h.req(`/api/platform/organisers/${body.organiser_id}/party-limit`, papi(a.s, { limit: 3 })); note("POST /api/platform/organisers/:id/party-limit");
      await h.req("/api/platform/site-owners", { cookies: { "__Host-sahra_p": a.s.token } }); note("GET /api/platform/site-owners");
      const other = await seedSiteOwner();
      await seedPlatformSession(other.sub, h.clock);
      await h.req(`/api/platform/site-owners/${other.id}/remove`, papi(a.s)); note("POST /api/platform/site-owners/:id/remove (1 session)");
      await h.req(`/api/platform/organisers/${body.organiser_id}/disable`, papi(a.s)); note("POST /api/platform/organisers/:id/disable (1 staff row)");
      await h.req(`/api/platform/parties/${id}/owner-invite`, papi(a.s, { staff_id: newId(), invite_id: newId(), name: "New", email: "measure-new@gmail.com" }));
      note("POST /api/platform/parties/:id/owner-invite");
      await h.req(`/api/platform/parties/${id}/manage`, papi(a.s)); note("POST /api/platform/parties/:id/manage (first time)");
      await h.req(`/api/platform/parties/${id}/manage`, papi(a.s)); note("POST /api/platform/parties/:id/manage (again)");
    } finally {
      spy.mockRestore();
    }
    if (DUMP) throw new Error(`ROWS ${JSON.stringify(out)}`);
    // Numbers are recorded in docs/DECISIONS.md (Workstream B). Pin the write counts.
    const w = (k: string) => (out[k] as { rows_written: number }).rows_written;
    expect(w("POST /api/platform/parties (create)")).toBe(10);
    expect(w("callback, later sign-in")).toBe(3);
    expect(w("GET /api/platform/site-owners")).toBe(0);
    expect(w("POST /api/platform/parties/:id/enable")).toBe(3);
    expect(w("GET /api/platform/me")).toBe(0);
    expect(w("POST /api/auth/platform/start")).toBe(0);
    expect(w("GET /api/platform/parties (counts, whole test database)")).toBe(0);
  });
});

describe("re-enabling a party", () => {
  it("clears disabled_at, stays paused (control object too), staff can sign in again; logged and audited", async () => {
    const h = await harness();
    const so = await siteOwner(h);
    const { party, owner, os } = await openParty(h);
    const door = await (await import("./helpers")).seedDoor(party, h.clock);
    const [t] = await testTickets(h, os, 1);
    expect((await h.req(`/api/platform/parties/${party}/disable`, papi(so.s))).status).toBe(200);
    const controlBefore = (await h.ledger.getControl(party))!;

    // Organisers and staff cannot re-enable.
    const o = await organiser(h);
    expect((await h.req(`/api/platform/parties/${party}/enable`, papi(o.s))).status).toBe(403);
    expect((await h.req(`/api/platform/parties/no-such-party/enable`, papi(so.s))).status).toBe(404);

    const r = await h.req(`/api/platform/parties/${party}/enable`, papi(so.s));
    expect(await r.json()).toEqual({ status: "enabled", admission: "paused" });
    const p = await env.DB.prepare("SELECT disabled_at, admission_state, rev, logged_rev, last_action FROM parties WHERE id = ?").bind(party).first();
    expect(p).toMatchObject({ disabled_at: null, admission_state: "paused", last_action: "party_enabled" });
    expect(p!.logged_rev).toBe(p!.rev);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE party_id = ? AND action = 'party_enabled'").bind(party).first("n")).toBe(1);
    // No intent for re-enabling (safe to lose).
    expect(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM intents WHERE party_id = ? AND action = 'party_enabled'").bind(party).first("n")).toBe(0);
    expect(await h.ledger.getControl(party)).toEqual(controlBefore);
    expect(await (await h.req(`/api/platform/parties/${party}/enable`, papi(so.s))).json()).toMatchObject({ status: "already" });

    // Old sessions stay revoked; scans still answer paused.
    expect(await scan(h, door, t!.qr)).toEqual({ verdict: "paused" });
    // The owner signs in again and reopens admission; then scanning works with a new door session.
    h.google.identity = { sub: owner.sub, email: `${owner.sub}@gmail.com` };
    const login = await googleLogin(h);
    expect(login.res.status).toBe(200);
    const sess = login.cookies["__Host-sahra_s"]!.value;
    const me = (await (await h.req("/api/me", { cookies: { "__Host-sahra_s": sess } })).json()) as { csrf: string; party: { id: string } };
    expect(me.party.id).toBe(party);
    const owner2 = { token: sess, csrf: me.csrf };
    expect((await h.req("/api/admission", api(owner2, { action: "open" }))).status).toBe(200);
    const door2 = await (await import("./helpers")).seedDoor(party, h.clock);
    expect(await scan(h, door2, t!.qr)).toMatchObject({ verdict: "admit" });
  });
});

describe("removing a site owner", () => {
  it("removes another site owner: intent first, their platform sessions end, they cannot sign in; never yourself", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const b = await siteOwner(h);
    const bSecond = await seedPlatformSession(b.sub, h.clock);
    expect(await (await h.req(`/api/platform/site-owners/${a.id}/remove`, papi(a.s))).json()).toEqual({ error: "cannot_remove_yourself" });
    // Organisers cannot remove site owners.
    const o = await organiser(h);
    expect((await h.req(`/api/platform/site-owners/${b.id}/remove`, papi(o.s))).status).toBe(403);

    const list = (await (await h.req("/api/platform/site-owners", { cookies: { "__Host-sahra_p": a.s.token } })).json()) as { site_owners: { id: string }[] };
    expect(list.site_owners.map((x) => x.id)).toEqual(expect.arrayContaining([a.id, b.id]));

    const r = await h.req(`/api/platform/site-owners/${b.id}/remove`, papi(a.s));
    expect(await r.json()).toEqual({ status: "removed", staff_disabled: 0 });
    expect(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM intents WHERE entity = 'platform_admin' AND entity_id = ? AND action = 'site_owner_removed'").bind(b.id).first("n")).toBe(1);
    expect((await logEntry("platform_admin", b.id, 2))!.state).toMatchObject({ last_action: "site_owner_removed", disabled_by: a.id });
    for (const s of [b.s, bSecond]) expect((await h.req("/api/platform/me", { cookies: { "__Host-sahra_p": s.token } })).status).toBe(401);
    h.google.identity = { sub: b.sub, email: `${b.sub}@gmail.com` };
    expect((await platformLogin(h)).res.status).toBe(403);
    expect(await (await h.req(`/api/platform/site-owners/${b.id}/remove`, papi(a.s))).json()).toMatchObject({ status: "already" });
    expect((await h.req(`/api/platform/site-owners/${newId()}/remove`, papi(a.s))).status).toBe(404);
  });

  it("two site owners removing each other at once: exactly one is removed, one always remains", async () => {
    const h = await harness();
    // Only these two are active in this check (the statement counts every active row).
    const a = await siteOwner(h);
    const b = await siteOwner(h);
    const [ra, rb] = await Promise.all([
      h.req(`/api/platform/site-owners/${b.id}/remove`, papi(a.s)),
      h.req(`/api/platform/site-owners/${a.id}/remove`, papi(b.s)),
    ]);
    const statuses = [ra.status, rb.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).not.toBe(200);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM platform_admins WHERE id IN (?, ?) AND disabled_at IS NULL").bind(a.id, b.id).first("n");
    expect(left).toBe(1);
  });

  it("the statement itself refuses removing yourself (the caller is always the last one left)", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const pdb = new PlatformDb(new D1Driver(env.DB));
    expect((await pdb.removeSiteOwner(a.s.hash, a.id, a.id, h.clock.now(), newId())).status).toBe("rejected");
    expect(await env.DB.prepare("SELECT disabled_at FROM platform_admins WHERE id = ?").bind(a.id).first("disabled_at")).toBeNull();
  });

  it("intent not written (ledger unreachable): the site owner is not removed; a retry removes them", async () => {
    const h = await harness();
    const a = await siteOwner(h);
    const b = await siteOwner(h);
    h.ledger.intentMode = "fail";
    expect((await h.req(`/api/platform/site-owners/${b.id}/remove`, papi(a.s))).status).toBe(503);
    expect(await env.DB.prepare("SELECT disabled_at FROM platform_admins WHERE id = ?").bind(b.id).first("disabled_at")).toBeNull();
    h.ledger.intentMode = "ok";
    expect(await (await h.req(`/api/platform/site-owners/${b.id}/remove`, papi(a.s))).json()).toMatchObject({ status: "removed" });
  });
});
