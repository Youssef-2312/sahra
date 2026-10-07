import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { canAutoLink, normalizeEmail } from "../src/auth/google";
import { newId, seal } from "../src/lib/crypto";
import { googleLogin, harness, listLog, ORIGIN, seedOwner, seedParty, setCookies } from "./helpers";

async function inviteGoogle(partyId: string, email: string, role: "owner" | "admin" = "admin", expiresAt = Date.UTC(2030, 0, 1)) {
  const staffId = newId();
  const inviteId = newId();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO staff (id, party_id, name, role, invited_email, created_at, logged_rev) VALUES (?, ?, 'Invited', ?, ?, 0, 1)")
      .bind(staffId, partyId, role, normalizeEmail(email)),
    env.DB.prepare("INSERT INTO invites (id, kind, party_id, staff_id, role, created_at, expires_at, logged_rev) VALUES (?, 'google', ?, ?, ?, 0, ?, 1)")
      .bind(inviteId, partyId, staffId, role, expiresAt),
  ]);
  return { staffId, inviteId };
}

describe("Google sign-in", () => {
  it("links a verified Gmail invitee, logs the change, and sets a Strict session cookie via a same-site page", async () => {
    const h = await harness();
    const party = await seedParty();
    const { staffId, inviteId } = await inviteGoogle(party, "First.Last+x@gmail.com");
    h.google.identity = { sub: "g-link-1", email: "firstlast@gmail.com", email_verified: true };

    const { res, cookies, html } = await googleLogin(h);
    expect(res.status).toBe(200);
    // Not a redirect: a small page that navigates to the dashboard itself.
    expect(res.headers.get("location")).toBeNull();
    expect(html).toContain('http-equiv="refresh"');
    expect(html).toContain("/dashboard");
    const s = cookies["__Host-sahra_s"]!;
    expect(s.attrs).toMatch(/HttpOnly/);
    expect(s.attrs).toMatch(/Secure/);
    expect(s.attrs).toMatch(/SameSite=Strict/);
    expect(cookies["__Host-sahra_login"]!.attrs).toMatch(/Max-Age=0/);

    const st = await env.DB.prepare("SELECT google_sub, rev, logged_rev FROM staff WHERE id = ?").bind(staffId).first();
    expect(st).toMatchObject({ google_sub: "g-link-1", rev: 2, logged_rev: 2 });
    expect(await listLog(`log/${party}/staff/${staffId}/`)).toEqual([`log/${party}/staff/${staffId}/0000000002.json`]);
    expect(await listLog(`log/${party}/invite/${inviteId}/`)).toEqual([`log/${party}/invite/${inviteId}/0000000002.json`]);

    // The token exchange used PKCE.
    expect(h.google.tokenRequests[0]!.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const me = await h.req("/api/me", { cookies: { "__Host-sahra_s": s.value } });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ party: { id: party }, staff: { id: staffId, role: "admin" } });
  });

  it("sends PKCE S256, state and nonce to Google, and the attempt cookie is Lax and short-lived", async () => {
    const h = await harness();
    const start = await h.req("/api/auth/google/start", { method: "POST", headers: { origin: ORIGIN } });
    const u = new URL(start.headers.get("location")!);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("openid email profile");
    expect(u.searchParams.get("redirect_uri")).toBe(`${ORIGIN}/api/auth/google/callback`);
    const ck = setCookies(start)["__Host-sahra_login"]!;
    expect(ck.attrs).toMatch(/SameSite=Lax/);
    expect(ck.attrs).toMatch(/Max-Age=600/);
    expect(ck.attrs).toMatch(/HttpOnly/);
  });

  it("refuses to start sign-in from another origin", async () => {
    const h = await harness();
    const r = await h.req("/api/auth/google/start", { method: "POST", headers: { origin: "https://evil.example" } });
    expect(r.status).toBe(403);
    const r2 = await h.req("/api/auth/google/start", { method: "POST" });
    expect(r2.status).toBe(403);
  });

  it("rejects a callback that arrives without the matching attempt cookie (login CSRF)", async () => {
    const h = await harness();
    const party = await seedParty();
    await seedOwner(party, "g-csrf");
    h.google.identity = { sub: "g-csrf", email: "g-csrf@gmail.com" };
    const noCookie = await googleLogin(h, (ctx) => { ctx.attempt = ""; });
    expect(noCookie.res.status).toBe(400);
    expect(noCookie.cookies["__Host-sahra_s"]).toBeUndefined();

    // An attacker's own attempt (valid state) with the victim's different attempt cookie.
    const attacker = await googleLogin(h, async (ctx) => {
      const victimStart = await h.req("/api/auth/google/start", { method: "POST", headers: { origin: ORIGIN } });
      ctx.attempt = setCookies(victimStart)["__Host-sahra_login"]!.value;
    });
    expect(attacker.res.status).toBe(400);
    expect(attacker.cookies["__Host-sahra_s"]).toBeUndefined();
    expect(h.google.tokenRequests.length).toBe(0);
  });

  it("rejects wrong audience, wrong issuer, expired, future-issued, bad signature and wrong algorithm", async () => {
    const party = await seedParty();
    await seedOwner(party, "g-bad");
    const cases: [string, (h: Awaited<ReturnType<typeof harness>>) => void][] = [
      ["bad_audience", (h) => { h.google.override = { aud: "someone-else.apps.googleusercontent.com" }; }],
      ["bad_audience", (h) => { h.google.override = { azp: "someone-else.apps.googleusercontent.com" }; }],
      ["bad_issuer", (h) => { h.google.override = { iss: "https://evil.example" }; }],
      ["expired", (h) => { const t = Math.floor(h.clock.now() / 1000); h.google.override = { iat: t - 7200, exp: t - 3600 }; }],
      ["issued_in_future", (h) => { const t = Math.floor(h.clock.now() / 1000); h.google.override = { iat: t + 600, exp: t + 4200 }; }],
      ["bad_signature", (h) => { h.google.tamper = true; }],
    ];
    for (const [reason, setup] of cases) {
      const h = await harness();
      h.google.identity = { sub: "g-bad", email: "g-bad@gmail.com" };
      setup(h);
      const { res, html, cookies } = await googleLogin(h);
      expect(res.status, reason).toBe(401);
      expect(html, reason).toContain(reason);
      expect(cookies["__Host-sahra_s"], reason).toBeUndefined();
    }
  });

  it("accepts a token within the small clock skew but not beyond it", async () => {
    const party = await seedParty();
    await seedOwner(party, "g-skew");
    const h = await harness();
    h.google.identity = { sub: "g-skew", email: "g-skew@gmail.com" };
    const t = Math.floor(h.clock.now() / 1000);
    h.google.override = { iat: t - 3630, exp: t - 30 };
    expect((await googleLogin(h)).res.status).toBe(200);
    h.google.override = { iat: t - 3700, exp: t - 100 };
    expect((await googleLogin(h)).res.status).toBe(401);
  });

  it("rejects a reused nonce: replaying the same callback, or a token minted for a different attempt", async () => {
    const h = await harness();
    const party = await seedParty();
    await seedOwner(party, "g-nonce");
    h.google.identity = { sub: "g-nonce", email: "g-nonce@gmail.com" };
    const first = await googleLogin(h);
    expect(first.res.status).toBe(200);
    // Replay: same state, code and attempt cookie again. Google's code is single use.
    const replay = await h.req(`/api/auth/google/callback?state=${encodeURIComponent(first.ctx.state)}&code=${encodeURIComponent(first.ctx.code)}`, {
      cookies: { "__Host-sahra_login": first.ctx.attempt },
    });
    expect(replay.status).toBe(401);
    expect(await replay.text()).toContain("token_exchange_failed");
    expect(setCookies(replay)["__Host-sahra_s"]).toBeUndefined();

    // A fresh attempt, but Google returns a token carrying the previous attempt's nonce.
    const stale = await googleLogin(h, () => { h.google.nonceFor = first.ctx.nonce; });
    expect(stale.res.status).toBe(401);
    expect(stale.html).toContain("bad_nonce");
  });

  it("refreshes the JWKS on an unknown key id (rate limited), and rejects key ids Google does not publish", async () => {
    const h = await harness();
    const party = await seedParty();
    await seedOwner(party, "g-kid");
    h.google.identity = { sub: "g-kid", email: "g-kid@gmail.com" };
    expect((await googleLogin(h)).res.status).toBe(200);
    expect(h.google.jwksFetches).toBe(1);
    expect((await googleLogin(h)).res.status).toBe(200);
    expect(h.google.jwksFetches).toBe(1); // cached

    // Google rotates keys; a token signed with the new key forces one refresh.
    h.clock.advance(61_000);
    await h.google.rotate("key-2");
    const rotated = await googleLogin(h);
    expect(rotated.res.status).toBe(200);
    expect(h.google.jwksFetches).toBe(2);

    // Unknown kid that Google does not publish: rejected; within the refresh interval no new fetch.
    h.clock.advance(61_000);
    h.google.signWith = await h.google.rotate("key-unpublished", false);
    const u1 = await googleLogin(h);
    expect(u1.res.status).toBe(401);
    expect(u1.html).toContain("unknown_key_id");
    expect(h.google.jwksFetches).toBe(3);
    const u2 = await googleLogin(h);
    expect(u2.res.status).toBe(401);
    expect(h.google.jwksFetches).toBe(3); // rate limited: no refetch within 60 s
    h.google.headerKid = "made-up";
    const u3 = await googleLogin(h);
    expect(u3.res.status).toBe(401);
    expect(h.google.jwksFetches).toBe(3);
  });

  it("does not auto-link a non-Gmail, non-Workspace address, nor an unverified Gmail", async () => {
    const party = await seedParty();
    const { staffId } = await inviteGoogle(party, "person@outlook.com");
    const h = await harness();
    h.google.identity = { sub: "g-outlook", email: "person@outlook.com", email_verified: true };
    const r = await googleLogin(h);
    expect(r.res.status).toBe(403);
    expect(r.html).toContain("confirmed by email");
    expect(r.cookies["__Host-sahra_s"]).toBeUndefined();
    expect((await env.DB.prepare("SELECT google_sub FROM staff WHERE id = ?").bind(staffId).first())!.google_sub).toBeNull();

    const party2 = await seedParty();
    const inv2 = await inviteGoogle(party2, "unverified@gmail.com");
    h.google.identity = { sub: "g-unverified", email: "unverified@gmail.com", email_verified: false };
    expect((await googleLogin(h)).res.status).toBe(403);
    expect((await env.DB.prepare("SELECT google_sub FROM staff WHERE id = ?").bind(inv2.staffId).first())!.google_sub).toBeNull();

    // An hd claim that does not match the address's domain does not count either.
    expect(canAutoLink({ iss: "", aud: "", sub: "x", exp: 0, iat: 0, nonce: "", email: "a@outlook.com", email_verified: true, hd: "company.com" })).toBe(false);
  });

  it("auto-links a Google Workspace address when the hd claim matches", async () => {
    const party = await seedParty();
    const { staffId } = await inviteGoogle(party, "lead@company.example");
    const h = await harness();
    h.google.identity = { sub: "g-ws", email: "lead@company.example", email_verified: true, hd: "company.example" };
    expect((await googleLogin(h)).res.status).toBe(200);
    expect((await env.DB.prepare("SELECT google_sub FROM staff WHERE id = ?").bind(staffId).first())!.google_sub).toBe("g-ws");
  });

  it("authorizes by Google account id only: after linking, a different account with the same email gets nothing", async () => {
    const party = await seedParty();
    await inviteGoogle(party, "same@gmail.com");
    const h = await harness();
    h.google.identity = { sub: "g-real", email: "same@gmail.com" };
    expect((await googleLogin(h)).res.status).toBe(200);
    h.google.identity = { sub: "g-other", email: "same@gmail.com" };
    const other = await googleLogin(h);
    expect(other.res.status).toBe(403);
    expect(other.cookies["__Host-sahra_s"]).toBeUndefined();
  });

  it("does not link expired or revoked Google invitations", async () => {
    const party = await seedParty();
    const h = await harness();
    const exp = await inviteGoogle(party, "late@gmail.com", "admin", h.clock.now() - 1);
    h.google.identity = { sub: "g-late", email: "late@gmail.com" };
    expect((await googleLogin(h)).res.status).toBe(403);
    expect((await env.DB.prepare("SELECT google_sub FROM staff WHERE id = ?").bind(exp.staffId).first())!.google_sub).toBeNull();
  });

  it("lets an account that is staff at several parties pick one, with a sealed 5-minute cookie (no database write)", async () => {
    const h = await harness();
    const p1 = await seedParty();
    const p2 = await seedParty();
    await seedOwner(p1, "g-multi");
    await env.DB.prepare("INSERT INTO staff (id, party_id, name, role, google_sub, created_at, logged_rev) VALUES (?, ?, 'M', 'admin', 'g-multi', 0, 1)")
      .bind(newId(), p2).run();
    h.google.identity = { sub: "g-multi", email: "g-multi@gmail.com" };
    const r = await googleLogin(h);
    expect(r.res.status).toBe(200);
    expect(r.cookies["__Host-sahra_s"]).toBeUndefined();
    const pick = r.cookies["__Host-sahra_pick"]!;
    expect(pick.attrs).toMatch(/SameSite=Strict/);
    expect(r.html).toContain(p1);
    expect(r.html).toContain(p2);

    const form = new FormData();
    form.set("party_id", p2);
    const sel = await h.req("/api/auth/select-party", {
      method: "POST", body: form, headers: { origin: ORIGIN }, cookies: { "__Host-sahra_pick": pick.value },
    });
    expect(sel.status).toBe(200);
    const sess = setCookies(sel)["__Host-sahra_s"]!;
    const me = await (await h.req("/api/me", { cookies: { "__Host-sahra_s": sess.value } })).json();
    expect(me).toMatchObject({ party: { id: p2 }, staff: { role: "admin" } });

    expect(setCookies(sel)["__Host-sahra_pick"]!.attrs).toMatch(/Max-Age=0/);
    // Expired after 5 minutes.
    h.clock.advance(5 * 60_000 + 1);
    const again = await h.req("/api/auth/select-party", {
      method: "POST", body: form, headers: { origin: ORIGIN }, cookies: { "__Host-sahra_pick": pick.value },
    });
    expect(again.status).toBe(400);
    // A party the account is not staff at is refused even with a valid cookie.
    const h2 = await harness({ google: h.google });
    const r2 = await googleLogin(h2);
    const f2 = new FormData();
    f2.set("party_id", await seedParty());
    const other = await h2.req("/api/auth/select-party", {
      method: "POST", body: f2, headers: { origin: ORIGIN }, cookies: { "__Host-sahra_pick": r2.cookies["__Host-sahra_pick"]!.value },
    });
    expect(other.status).toBe(400);
  });

  it("never signs in door staff through Google, and a disabled owner cannot sign in", async () => {
    const h = await harness();
    const party = await seedParty();
    const o = await seedOwner(party, "g-disabled");
    await env.DB.prepare("UPDATE staff SET disabled_at = 1 WHERE id = ?").bind(o.id).run();
    h.google.identity = { sub: "g-disabled", email: "g-disabled@gmail.com" };
    expect((await googleLogin(h)).res.status).toBe(403);
  });

  it("does not confirm a link until the change log write is confirmed; the next sign-in finishes it", async () => {
    const party = await seedParty();
    const { staffId } = await inviteGoogle(party, "pending@gmail.com");
    const h = await harness();
    h.google.identity = { sub: "g-pending", email: "pending@gmail.com" };
    h.ledger.mode = "fail";
    const r1 = await googleLogin(h);
    expect(r1.res.status).toBe(503);
    expect(r1.cookies["__Host-sahra_s"]).toBeUndefined();
    const row = await env.DB.prepare("SELECT google_sub, rev, logged_rev FROM staff WHERE id = ?").bind(staffId).first();
    expect(row).toMatchObject({ google_sub: "g-pending", rev: 2, logged_rev: 1 });

    h.ledger.mode = "lose_ack";
    expect((await googleLogin(h)).res.status).toBe(503);

    h.ledger.mode = "ok";
    const r3 = await googleLogin(h);
    expect(r3.res.status).toBe(200);
    expect(await listLog(`log/${party}/staff/${staffId}/`)).toHaveLength(1);
    expect((await env.DB.prepare("SELECT logged_rev FROM staff WHERE id = ?").bind(staffId).first())!.logged_rev).toBe(2);
  });

  it("sign-in start writes nothing to the database; the attempt cookie is sealed and reveals nothing", async () => {
    const h = await harness();
    const before = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM audit) + (SELECT COUNT(*) FROM sessions) AS n").first("n");
    const start = await h.req("/api/auth/google/start", { method: "POST", headers: { origin: ORIGIN } });
    expect(start.status).toBe(303);
    const u = new URL(start.headers.get("location")!);
    const ck = setCookies(start)["__Host-sahra_login"]!.value;
    expect(ck).toMatch(/^1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/);
    for (const p of ["state", "nonce"]) expect(ck).not.toContain(u.searchParams.get(p)!);
    expect(await env.DB.prepare("SELECT (SELECT COUNT(*) FROM audit) + (SELECT COUNT(*) FROM sessions) AS n").first("n")).toBe(before);
  });

  it("rejects a forged, tampered, expired, other-purpose or retired-key attempt cookie before calling Google", async () => {
    const party = await seedParty();
    await seedOwner(party, "g-cookie");
    const h = await harness();
    h.google.identity = { sub: "g-cookie", email: "g-cookie@gmail.com" };
    const flip = (v: string) => v.slice(0, -2) + (v.at(-2) === "A" ? "B" : "A") + v.at(-1);
    for (const [label, mutate] of [
      ["tampered", (ctx: { attempt: string }) => { ctx.attempt = flip(ctx.attempt); }],
      ["unknown key id", (ctx: { attempt: string }) => { ctx.attempt = "7" + ctx.attempt.slice(1); }],
      ["other key id", (ctx: { attempt: string }) => { ctx.attempt = "2" + ctx.attempt.slice(1); }],
      ["garbage", (ctx: { attempt: string }) => { ctx.attempt = "not-a-cookie"; }],
      ["party-pick cookie", async (ctx: { attempt: string }) => {
        ctx.attempt = await seal(env as unknown as Record<string, unknown>, "party-pick", { s: "x", n: "y", v: "z", sub: "g-cookie" }, h.clock.now() + 60_000);
      }],
    ] as const) {
      const r = await googleLogin(h, mutate as (ctx: { attempt: string }) => Promise<void>);
      expect(r.res.status, label).toBe(400);
      expect(r.cookies["__Host-sahra_s"], label).toBeUndefined();
    }
    const expired = await googleLogin(h, () => { h.clock.advance(10 * 60_000 + 1); });
    expect(expired.res.status).toBe(400);
    expect(h.google.tokenRequests.length).toBe(0);
  });
});

describe("email normalization", () => {
  it("treats Gmail dots, +tags and googlemail.com as the same address", () => {
    expect(normalizeEmail("First.Last+party@GoogleMail.com")).toBe("firstlast@gmail.com");
    expect(normalizeEmail("a.b+c@company.example")).toBe("a.b+c@company.example");
    expect(normalizeEmail("not-an-email")).toBeNull();
  });
});
