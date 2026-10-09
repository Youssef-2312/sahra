// Workstream C: guest sign-up (Turnstile, capacity, screenshots), the approval
// queue, release, cancel / reissue / name transfer, the guest ticket page, resend
// link and export.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES } from "../src/storage";
import { newId, newToken } from "../src/lib/crypto";
import {
  api, guestParty, harness, JPEG, openParty, ORIGIN, OutageDriver, PNG, scan, seedDoor, seedOwner, seedSession, signup, signupInit,
  viewTicket, type Harness,
} from "./helpers";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
});
afterEach(() => { vi.restoreAllMocks(); OutageDriver.down = { main: false, ledger: false }; });

type ReqLog = { route: string; method: string; status: number; d1_queries: number; rows_read: number; rows_written: number; ledger_rows_written: number };
function reqLogs(): ReqLog[] {
  return logs.filter((x) => x.startsWith('{"evt":"req"')).map((l) => JSON.parse(l) as ReqLog);
}
const lastReq = () => reqLogs().at(-1)!;

async function ticket(id: string) {
  return env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first<Record<string, unknown>>();
}
async function outbox(ticketId: string) {
  return (await env.DB.prepare("SELECT kind, to_email, subject, body_text, status FROM outbox WHERE ticket_id = ?").bind(ticketId).all()).results;
}
async function held(party: string) {
  return Number(await env.DB.prepare("SELECT COALESCE(SUM(people), 0) AS n FROM tickets WHERE party_id = ? AND status IN ('pending', 'approved')")
    .bind(party).first("n"));
}

/** Signs up, approves and releases one ticket through the API. Returns its id and link. */
async function releasedTicket(h: Harness, party: string, os: { token: string; csrf: string }, f: Parameters<typeof signup>[2] = {}) {
  const s = await signup(h, party, f);
  expect(s.status, JSON.stringify(s.body)).toBe(201);
  const id = s.body.ticket_id!;
  expect((await h.req("/api/tickets/approve", api(os, { ids: [id] }))).status).toBe(200);
  expect((await h.req("/api/tickets/release", api(os, { ids: [id] }))).status).toBe(200);
  return { id, link: s.body.link! };
}

describe("guest sign-up", () => {
  it("stores a pending ticket with answers and the screenshot; a retry with the same sign-up token is the same ticket", async () => {
    const h = await harness();
    const form = { questions: [{ id: "insta", label: "Instagram", type: "text", required: true }], screenshot: "required" };
    const { party } = await guestParty(h, { form });
    const token = newToken();
    const s = await signup(h, party, { signup: token, name: "  Laila   Hassan ", email: "Laila@Example.com", people: 2, answers: { insta: "@laila" } });
    expect(s.status).toBe(201);
    expect(s.body.link).toMatch(/^\/ticket\.html#t=T1\./);
    const t = await ticket(s.body.ticket_id!);
    expect(t).toMatchObject({ status: "pending", people: 2, guest_name: "Laila Hassan", guest_email: "laila@example.com",
      answers: JSON.stringify({ insta: "@laila" }), last_action: "ticket_requested", rev: 1, logged_rev: 1 });
    expect(t!.screenshot_key).toMatch(/^f1:\d+$/);
    const f = await env.FILES!.prepare("SELECT party_id, ticket_id, content_type, size FROM files WHERE ticket_id = ?").bind(t!.id).first();
    expect(f).toEqual({ party_id: party, ticket_id: t!.id, content_type: "image/png", size: PNG.length });
    expect(await env.LEDGER.prepare("SELECT action FROM change_log WHERE event_id = ?").bind(`ticket:${t!.id}:1`).first("action")).toBe("ticket_requested");

    const again = await signup(h, party, { signup: token, name: "Laila Hassan", email: "laila@example.com", people: 2, answers: { insta: "@laila" } });
    expect(again.status).toBe(200);
    expect(again.body.ticket_id).toBe(t!.id);
    expect(lastReq().rows_written).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n")).toBe(1);
    expect(await env.FILES!.prepare("SELECT COUNT(*) AS n FROM files WHERE party_id = ?").bind(party).first("n")).toBe(1);
  });

  it("checks answers against the party's own questions, and people against the party's maximum", async () => {
    const h = await harness();
    const form = { questions: [{ id: "size", label: "Size", type: "choice", options: ["S", "M"], required: true }], screenshot: "optional" };
    const { party } = await guestParty(h, { form, maxPeople: 2 });
    expect((await signup(h, party, { answers: {} })).body.error).toBe("invalid_answers");
    expect((await signup(h, party, { answers: { size: "XL" } })).body.error).toBe("invalid_answers");
    expect((await signup(h, party, { answers: { size: "S", other: "x" } })).body.error).toBe("invalid_answers");
    expect((await signup(h, party, { answers: { size: "S" }, people: 3 })).body.error).toBe("too_many_people");
    expect((await signup(h, party, { answers: { size: "M" }, people: 2, screenshot: null })).status).toBe(201);
    const none = await guestParty(h, { form: { questions: [], screenshot: "none" } });
    expect((await signup(h, none.party)).body.error).toBe("screenshot_not_wanted");
    const dflt = await guestParty(h);
    expect((await signup(h, dflt.party, { screenshot: null })).body.error).toBe("screenshot_required");
  });

  it("Turnstile: failing, spent, missing, test key in production or unreachable -> refused before any database access", async () => {
    const cases: [Partial<Record<string, unknown>>, number, string, boolean?][] = [
      [{ TURNSTILE_SECRET: "2x0000000000000000000000000000000AA" }, 403, "bot_check_failed"],
      [{ TURNSTILE_SECRET: "3x0000000000000000000000000000000AA" }, 403, "bot_check_failed"],
      [{ TURNSTILE_SECRET: undefined }, 503, "bot_check_not_configured"],
      [{ TURNSTILE_SITE_KEY: undefined }, 503, "bot_check_not_configured"],
      [{ ENABLE_TEST_TICKETS: "0" }, 503, "bot_check_not_configured"],
      [{}, 503, "bot_check_unavailable", true],
    ];
    for (const [e, status, error, down] of cases) {
      const h = await harness({ env: e as never });
      const { party } = await guestParty(h);
      if (down) h.turnstile.down = true;
      logs = [];
      const s = await signup(h, party);
      expect([s.status, s.body.error], JSON.stringify(e)).toEqual([status, error]);
      const m = lastReq();
      expect(m.d1_queries, JSON.stringify(e)).toBe(0);
      expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n")).toBe(0);
    }
    // A missing token is a failure without asking Cloudflare.
    const h = await harness();
    const { party } = await guestParty(h);
    expect((await signup(h, party, { turnstile: null })).status).toBe(403);
    expect(h.turnstile.calls).toBe(0);
  });

  it("refuses an oversize screenshot and anything that is not JPEG, PNG or WebP, writing nothing", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const big = new Uint8Array(MAX_FILE_BYTES + 1);
    big.set(JPEG);
    const tooBig = await signup(h, party, { screenshot: big });
    expect([tooBig.status, tooBig.body.error]).toEqual([413, "too_large"]);
    expect(h.turnstile.calls).toBe(0);
    // Whole request above the limit: refused from Content-Length, before reading the body.
    const huge = await signupInit({ screenshot: new Uint8Array(MAX_FILE_BYTES + 100_000) });
    expect((await h.req(`/api/guest/parties/${party}/signup`, huge)).status).toBe(413);
    for (const bad of [new TextEncoder().encode("GIF89a......"), new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'/>"), new Uint8Array([0xff, 0xd8])]) {
      const r = await signup(h, party, { screenshot: bad });
      expect([r.status, r.body.error]).toEqual([415, "screenshot_must_be_jpeg_png_or_webp"]);
    }
    const webp = new Uint8Array([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8 ")]);
    expect((await signup(h, party, { screenshot: webp })).status).toBe(201);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n")).toBe(1);
    expect(await env.FILES!.prepare("SELECT COUNT(*) AS n FROM files WHERE party_id = ?").bind(party).first("n")).toBe(1);
    // Exactly the maximum is accepted.
    const max = new Uint8Array(MAX_FILE_BYTES);
    max.set(JPEG);
    expect((await signup(h, party, { screenshot: max })).status).toBe(201);
  });

  it("without the files database, a sign-up with a screenshot answers 503 and writes nothing", async () => {
    const h = await harness({ env: { FILES: undefined } as never });
    const { party } = await guestParty(h, { form: { questions: [], screenshot: "optional" } });
    const s = await signup(h, party);
    expect([s.status, s.body.error]).toEqual([503, "uploads_not_configured"]);
    expect(lastReq().d1_queries).toBe(0);
    expect((await signup(h, party, { screenshot: null })).status).toBe(201);
  });
});

describe("capacity", () => {
  it("simultaneous sign-ups at the limit never pass it, and requests close when full", async () => {
    const h = await harness();
    const { party } = await guestParty(h, { capacity: 7, maxPeople: 2 });
    // 3 places taken already, so 4 are left; 14 guests ask at once for 1 or 2 places each.
    for (let i = 0; i < 3; i++) expect((await signup(h, party)).status).toBe(201);
    const rs = await Promise.all(Array.from({ length: 14 }, (_, i) => signup(h, party, { people: (i % 2) + 1 })));
    const ok = rs.filter((r) => r.status === 201);
    const full = rs.filter((r) => r.status === 409);
    expect(ok.length + full.length).toBe(14);
    expect(full.every((r) => r.body.error === "full")).toBe(true);
    expect(await held(party)).toBeLessThanOrEqual(7);
    expect(ok.length).toBeGreaterThanOrEqual(2);
    // Fill to exactly 7 with single places, then the form says full and sign-up answers "full".
    while ((await held(party)) < 7) expect((await signup(h, party, { people: 1 })).status).toBe(201);
    const f = await (await h.req(`/api/guest/parties/${party}`)).json() as { full: boolean; places_left: number };
    expect(f).toMatchObject({ full: true, places_left: 0 });
    expect((await signup(h, party)).body.error).toBe("full");
    expect(await held(party)).toBe(7);
  });

  it("many simultaneous single-place sign-ups: exactly the capacity is created", async () => {
    const h = await harness();
    const { party } = await guestParty(h, { capacity: 5 });
    const rs = await Promise.all(Array.from({ length: 12 }, () => signup(h, party)));
    expect(rs.filter((r) => r.status === 201)).toHaveLength(5);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(7);
    expect(await held(party)).toBe(5);
  });

  it("a rejected or cancelled ticket frees its places", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { capacity: 2 });
    const a = await signup(h, party);
    const b = await signup(h, party);
    expect((await signup(h, party)).body.error).toBe("full");
    expect((await (await h.req("/api/tickets/reject", api(os, { ids: [a.body.ticket_id] }))).json())).toEqual({ results: { [a.body.ticket_id!]: "done" } });
    expect((await signup(h, party)).status).toBe(201);
    expect((await h.req(`/api/tickets/${b.body.ticket_id}/cancel`, api(os, { op: newId() }))).status).toBe(200);
    expect((await signup(h, party)).status).toBe(201);
    expect(await held(party)).toBe(2);
  });

  it("approval respects capacity in the same statement (capacity lowered after sign-ups; two approvers at once)", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { capacity: 6, maxPeople: 2 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await signup(h, party, { people: i < 2 ? 2 : 1 })).body.ticket_id!);
    await env.DB.prepare("UPDATE parties SET capacity = 3 WHERE id = ?").bind(party).run();
    const admin = await seedOwner(party, `adm-${newId()}`, "admin");
    const as = await seedSession(party, admin.id, "admin", h.clock);
    const [r1, r2] = await Promise.all([
      h.req("/api/tickets/approve", api(os, { ids })),
      h.req("/api/tickets/approve", api(as, { ids: [...ids].reverse() })),
    ]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    const approved = Number(await env.DB.prepare("SELECT COALESCE(SUM(people), 0) AS n FROM tickets WHERE party_id = ? AND status = 'approved'").bind(party).first("n"));
    expect(approved).toBeLessThanOrEqual(3);
    expect(approved).toBeGreaterThanOrEqual(2);
    const res = { ...((await r1.json()) as { results: Record<string, string> }).results };
    expect(Object.values(res)).toContain("refused");
  });
});

describe("approval queue, release, screenshots", () => {
  it("lists pending sign-ups with answers; the screenshot is served only to this party's owner/admin, never cached", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const s = await signup(h, party, { screenshot: JPEG, name: "Queue Guest" });
    const q = (await (await h.req("/api/tickets?status=pending", api(os, undefined, "GET"))).json()) as { tickets: Record<string, unknown>[] };
    expect(q.tickets).toHaveLength(1);
    expect(q.tickets[0]).toMatchObject({ id: s.body.ticket_id, guest_name: "Queue Guest", has_screenshot: true, status: "pending" });
    const img = await h.req(`/api/tickets/${s.body.ticket_id}/screenshot`, api(os, undefined, "GET"));
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("cache-control")).toMatch(/no-store/);
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG);
    const admin = await seedOwner(party, `adm-${newId()}`, "admin");
    expect((await h.req(`/api/tickets/${s.body.ticket_id}/screenshot`, api(await seedSession(party, admin.id, "admin", h.clock), undefined, "GET"))).status).toBe(200);

    const door = await seedDoor(party, h.clock);
    expect((await h.req(`/api/tickets/${s.body.ticket_id}/screenshot`, api(door, undefined, "GET"))).status).toBe(403);
    expect((await h.req("/api/tickets?status=pending", api(door, undefined, "GET"))).status).toBe(403);
    expect((await h.req("/api/tickets/approve", api(door, { ids: [s.body.ticket_id] }))).status).toBe(403);
    const other = await guestParty(h);
    expect((await h.req(`/api/tickets/${s.body.ticket_id}/screenshot`, api(other.os, undefined, "GET"))).status).toBe(404);
    expect((await h.req("/api/tickets/approve", api(other.os, { ids: [s.body.ticket_id] }))).status).toBe(200);
    expect((await ticket(s.body.ticket_id!))!.status).toBe("pending");
  });

  it("bulk approve and release are one batch each; approving sends nothing; outbox rows only for tickets this release released", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await signup(h, party, { email: `g${i}@example.com`, name: `Guest ${i} \u{1F389}` })).body.ticket_id!);
    logs = [];
    const ap = await h.req("/api/tickets/approve", api(os, { ids: ids.slice(0, 4) }));
    expect((await ap.json() as { results: Record<string, string> }).results).toEqual(Object.fromEntries(ids.slice(0, 4).map((id) => [id, "done"])));
    const apOne = lastReq();
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id = ?").bind(party).first("n"))).toBe(0);
    // Release ticket 0 alone first; then a bulk release of 0..4 releases only 1, 2, 3 (4 is still pending).
    await h.req("/api/tickets/release", api(os, { ids: [ids[0]] }));
    logs = [];
    const rl = await h.req("/api/tickets/release", api(os, { ids }));
    expect((await rl.json() as { results: Record<string, string> }).results).toEqual({
      [ids[0]!]: "already", [ids[1]!]: "done", [ids[2]!]: "done", [ids[3]!]: "done", [ids[4]!]: "refused",
    });
    const rlBulk = lastReq();
    // Session check + per-party counter (src/limits/) + the party's email texts + read for the emails + the release batch + change log (2).
    expect(rlBulk.d1_queries).toBe(apOne.d1_queries + 3);
    for (const [i, id] of ids.entries()) {
      const rows = await outbox(id);
      expect(rows, `ticket ${i}`).toHaveLength(i < 4 ? 1 : 0);
      if (i < 4) {
        expect(rows[0]).toMatchObject({ kind: "ticket_released", to_email: `g${i}@example.com`, status: "queued" });
        expect(String(rows[0]!.body_text)).toContain(`${ORIGIN}/ticket.html#t=T1.`);
        expect(String(rows[0]!.body_text)).not.toMatch(/[\u{1F000}-\u{1FFFF}]/u);
      }
    }
    // A second release of the same tickets adds nothing.
    await h.req("/api/tickets/release", api(os, { ids }));
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id = ?").bind(party).first("n"))).toBe(4);
    expect((await h.req("/api/tickets/approve", api(os, { ids: Array.from({ length: 21 }, (_, i) => ids[0]!.slice(0, 14) + String(i).padStart(2, "0")) }))).status).toBe(400);
  });

  it("rejection reason is stored and shown to the guest", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const s = await signup(h, party);
    await h.req("/api/tickets/reject", api(os, { ids: [s.body.ticket_id], reason: "Amount does not match" }));
    const v = await viewTicket(h, s.body.link!);
    expect(v.body.ticket).toMatchObject({ status: "rejected", reject_reason: "Amount does not match", qr: null });
    expect(await ticket(s.body.ticket_id!)).toMatchObject({ rejected_by: expect.any(String), reject_reason: "Amount does not match" });
  });
});

describe("guest ticket page", () => {
  it("shows the address with the ticket only when the party's address mode allows it", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    await env.DB.prepare("UPDATE parties SET address = 'Street 90, Sodic, 112389, Apt 12', venue_name = 'Ahmed''s place', address_mode = 'with_ticket' WHERE id = ?").bind(party).run();
    const s = await signup(h, party);
    const id = s.body.ticket_id!;
    expect((await viewTicket(h, s.body.link!)).body.party).toMatchObject({ address: null, venue_name: null });
    await h.req("/api/tickets/approve", api(os, { ids: [id] }));
    expect((await viewTicket(h, s.body.link!)).body.party).toMatchObject({ address: null });
    await h.req("/api/tickets/release", api(os, { ids: [id] }));
    expect((await viewTicket(h, s.body.link!)).body.party).toMatchObject({ address: "Street 90, Sodic, 112389, Apt 12", venue_name: "Ahmed's place", reveal: null });
    // Manual mode before "Reveal now": hidden even for a released ticket.
    await env.DB.prepare("UPDATE parties SET address_mode = 'manual', revealed_at = NULL WHERE id = ?").bind(party).run();
    expect((await viewTicket(h, s.body.link!)).body.party).toMatchObject({ address: null, reveal: { mode: "manual", waiting_for: "owner" } });
  });

  it("shows the QR only when approved + released + not on hold", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const s = await signup(h, party, { name: "Page Guest" });
    const id = s.body.ticket_id!;
    let v = await viewTicket(h, s.body.link!);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ party: { id: party, name: `Party ${party}` }, ticket: { status: "pending", qr: null, guest_name: "Page Guest" } });
    // Party details through visiblePartyDetails: a pending ticket never sees a hidden place.
    expect(v.body.party).toMatchObject({ address: null, map_url: null, venue_name: null, reveal: { waiting_for: "ticket" } });
    await h.req("/api/tickets/approve", api(os, { ids: [id] }));
    v = await viewTicket(h, s.body.link!);
    expect(v.body.ticket).toMatchObject({ status: "approved", qr: null });
    await h.req("/api/tickets/release", api(os, { ids: [id] }));
    v = await viewTicket(h, s.body.link!);
    expect(v.body.ticket!.status).toBe("released");
    expect(v.body.ticket!.qr).toMatch(new RegExp(`^S1\\.${party.toUpperCase()}\\.1${id}\\.1\\.`));
    await env.DB.prepare("UPDATE tickets SET hold_at = 1, hold_reason = 'test' WHERE id = ?").bind(id).run();
    v = await viewTicket(h, s.body.link!);
    expect(v.body.ticket).toMatchObject({ on_hold: true, qr: null });
    expect(lastReq().rows_written).toBe(0);
  });

  it("refuses tampered links, links for another party, and a QR code used as a link", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const { id, link } = await releasedTicket(h, party, os);
    const token = link.replace(/^.*#t=/, "");
    expect((await viewTicket(h, token)).status).toBe(200);
    for (let i = 0; i < token.length; i += 3) {
      const ch = token[i] === "A" ? "B" : "A";
      expect((await viewTicket(h, token.slice(0, i) + ch + token.slice(i + 1))).status, `position ${i}`).toBe(404);
    }
    const qr = (await viewTicket(h, token)).body.ticket!.qr!;
    expect((await viewTicket(h, qr)).status).toBe(404);
    expect((await viewTicket(h, qr.replace(/^S1/, "T1"))).status).toBe(404);
    expect((await h.req("/api/guest/ticket")).status).toBe(404);
    expect(id).toHaveLength(16);
  });
});

describe("cancel, reissue, name transfer", () => {
  async function setup() {
    const h = await harness();
    const { party, os } = await openParty(h);
    const door = await seedDoor(party, h.clock);
    return { h, party, os, door };
  }
  const qrOf = async (h: Harness, link: string) => (await viewTicket(h, link)).body.ticket!.qr!;

  it("cancelled: the QR can no longer be admitted", async () => {
    const { h, party, os, door } = await setup();
    const { id, link } = await releasedTicket(h, party, os);
    const qr = await qrOf(h, link);
    const op = newId();
    expect(await (await h.req(`/api/tickets/${id}/cancel`, api(os, { op }))).json()).toEqual({ status: "done" });
    expect(await scan(h, door, qr)).toMatchObject({ verdict: "stop" });
    expect((await viewTicket(h, link)).body.ticket).toMatchObject({ status: "cancelled", qr: null });
    // The same op again (a retry after "pending") is recognized.
    expect(await (await h.req(`/api/tickets/${id}/cancel`, api(os, { op }))).json()).toEqual({ status: "already" });
  });

  it("reissued: the old QR is refused, the new one (same link) admits once", async () => {
    const { h, party, os, door } = await setup();
    const { id, link } = await releasedTicket(h, party, os);
    const old = await qrOf(h, link);
    expect((await h.req(`/api/tickets/${id}/reissue`, api(os, { op: newId() }))).status).toBe(200);
    const fresh = await qrOf(h, link);
    expect(fresh).not.toBe(old);
    expect(await scan(h, door, old)).toMatchObject({ verdict: "stop" });
    expect(await scan(h, door, fresh)).toMatchObject({ verdict: "admit" });
    expect(await scan(h, door, fresh)).toMatchObject({ verdict: "used" });
  });

  it("name transfer: new name on the ticket, old QR and old link stop working, the new holder gets a link", async () => {
    const { h, party, os, door } = await setup();
    const { id, link } = await releasedTicket(h, party, os, { name: "Old Holder", email: "old@example.com" });
    const oldQr = await qrOf(h, link);
    const r = await h.req(`/api/tickets/${id}/transfer`, api(os, { op: newId(), name: "New Holder", email: "new@example.com" }));
    expect(r.status).toBe(200);
    const { link: newLink } = (await r.json()) as { link: string };
    expect((await viewTicket(h, link)).status).toBe(404);
    const nv = await viewTicket(h, newLink);
    expect(nv.body.ticket).toMatchObject({ guest_name: "New Holder", status: "released" });
    expect(await scan(h, door, oldQr)).toMatchObject({ verdict: "stop" });
    expect(await scan(h, door, nv.body.ticket!.qr!)).toMatchObject({ verdict: "admit", name: "New Holder" });
    const mails = await outbox(id);
    expect(mails.map((m) => [m.kind, m.to_email])).toEqual(expect.arrayContaining([["ticket_released", "old@example.com"], ["ticket_link", "new@example.com"]]));
    expect(String(mails.find((m) => m.kind === "ticket_link")!.body_text)).toContain(newLink);
    // A used ticket cannot be transferred.
    expect((await h.req(`/api/tickets/${id}/transfer`, api(os, { op: newId(), name: "Third" }))).status).toBe(409);
  });

  it("the intent is in the ledger before the change; if it cannot be written nothing changes, and a retry completes", async () => {
    for (const action of ["cancel", "reissue", "transfer"] as const) {
      const { h, party, os } = await setup();
      const { id } = await releasedTicket(h, party, os);
      const before = await ticket(id);
      const op = newId();
      const body = action === "transfer" ? { op, name: "Someone Else" } : { op };
      h.ledger.intentMode = "fail";
      const r = await h.req(`/api/tickets/${id}/${action}`, api(os, body));
      expect([r.status, ((await r.json()) as { status: string }).status], action).toEqual([503, "pending"]);
      expect(await ticket(id), action).toEqual(before);
      expect(await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM intents WHERE op_id = ?").bind(op).first("n")).toBe(0);
      h.ledger.intentMode = "ok";
      expect((await h.req(`/api/tickets/${id}/${action}`, api(os, body))).status, action).toBe(200);
      const after = await ticket(id);
      expect(after!.last_op).toBe(op);
      const intent = await env.LEDGER.prepare("SELECT entity, entity_id, action FROM intents WHERE op_id = ?").bind(op).first();
      expect(intent, action).toEqual({ entity: "ticket", entity_id: id, action: action === "cancel" ? "cancelled" : action === "reissue" ? "reissued" : "name_transferred" });
    }
  });
});

describe("ledger unreachable", () => {
  it("sign-up: pending, nothing confirmed; the retry (same sign-up token) completes without a second ticket", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const token = newToken();
    h.ledger.mode = "fail";
    const s = await signup(h, party, { signup: token });
    expect([s.status, s.body.status]).toEqual([503, "pending"]);
    const rows = (await env.DB.prepare("SELECT id, rev, logged_rev FROM tickets WHERE party_id = ?").bind(party).all()).results;
    expect(rows).toEqual([{ id: expect.any(String), rev: 1, logged_rev: 0 }]);
    h.ledger.mode = "ok";
    const again = await signup(h, party, { signup: token });
    expect(again.status).toBe(200);
    expect(again.body.ticket_id).toBe(rows[0]!.id);
    expect(await ticket(String(rows[0]!.id))).toMatchObject({ logged_rev: 1 });
  });

  it("approve and release: pending, retry completes; the release email exists once", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const id = (await signup(h, party)).body.ticket_id!;
    h.ledger.mode = "fail";
    expect((await h.req("/api/tickets/approve", api(os, { ids: [id] }))).status).toBe(503);
    h.ledger.mode = "ok";
    expect(await (await h.req("/api/tickets/approve", api(os, { ids: [id] }))).json()).toEqual({ results: { [id]: "already" } });
    expect(await ticket(id)).toMatchObject({ status: "approved", rev: 2, logged_rev: 2 });
    h.ledger.mode = "fail";
    expect((await h.req("/api/tickets/release", api(os, { ids: [id] }))).status).toBe(503);
    h.ledger.mode = "ok";
    expect(await (await h.req("/api/tickets/release", api(os, { ids: [id] }))).json()).toEqual({ results: { [id]: "already" } });
    expect(await ticket(id)).toMatchObject({ rev: 3, logged_rev: 3 });
    expect(await outbox(id)).toHaveLength(1);
  });

  it("main database unreachable: sign-up answers 503 and writes nothing", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    OutageDriver.down.main = true;
    const s = await signup(h, party);
    expect(s.status).toBe(503);
    OutageDriver.down.main = false;
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n")).toBe(0);
  });
});

describe("resend my ticket link", () => {
  const resend = (h: Harness, party: string, email: string) => h.req(`/api/guest/parties/${party}/resend`, {
    method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" },
    body: JSON.stringify({ email, turnstile: "XXXX.DUMMY.TOKEN.XXXX" }),
  });

  it("same answer for an unknown address; one email for a known one, at most once per 10 minutes", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const s = await signup(h, party, { email: "known@example.com" });
    const unknown = await resend(h, party, "nobody@example.com");
    const known = await resend(h, party, " Known@Example.com ");
    expect(unknown.status).toBe(200);
    expect(known.status).toBe(200);
    expect(await unknown.json()).toEqual(await known.json());
    const rows = (await env.DB.prepare("SELECT kind, to_email, ticket_id, body_text FROM outbox WHERE party_id = ?").bind(party).all()).results;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "ticket_link", to_email: "known@example.com", ticket_id: s.body.ticket_id });
    expect(String(rows[0]!.body_text)).toContain(`${ORIGIN}${s.body.link}`);
    expect((await resend(h, party, "known@example.com")).status).toBe(200);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id = ?").bind(party).first("n")).toBe(1);
    h.clock.advance(10 * 60_000);
    await resend(h, party, "known@example.com");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id = ?").bind(party).first("n")).toBe(2);
  });
});

describe("export and form", () => {
  it("returns the guest list with who approved, released and scanned and when, paged", async () => {
    const h = await harness();
    const { party, os, owner } = await openParty(h);
    const door = await seedDoor(party, h.clock);
    const { id, link } = await releasedTicket(h, party, os, { name: "Export Guest" });
    expect((await scan(h, door, (await viewTicket(h, link)).body.ticket!.qr!)).verdict).toBe("admit");
    for (let i = 0; i < 2; i++) await signup(h, party);
    const p1 = (await (await h.req("/api/tickets/export?limit=2", api(os, undefined, "GET"))).json()) as { tickets: Record<string, unknown>[]; next: string };
    expect(p1.tickets).toHaveLength(2);
    const p2 = (await (await h.req(`/api/tickets/export?limit=2&after=${p1.next}`, api(os, undefined, "GET"))).json()) as { tickets: Record<string, unknown>[]; next: null };
    expect(p2.tickets).toHaveLength(1);
    expect(p2.next).toBeNull();
    const row = [...p1.tickets, ...p2.tickets].find((t) => t.id === id)!;
    const ownerName = await env.DB.prepare("SELECT name FROM staff WHERE id = ?").bind(owner.id).first("name");
    const doorName = await env.DB.prepare("SELECT name FROM staff WHERE id = ?").bind(door.id).first("name");
    expect(row).toMatchObject({ guest_name: "Export Guest", approved_by: ownerName, released_by: ownerName, scanned_by: doorName,
      approved_at: expect.any(Number), released_at: expect.any(Number), used_at: expect.any(Number) });
    expect((await h.req("/api/tickets/export", api(door, undefined, "GET"))).status).toBe(403);
  });

  it("owner/admin sets the party's questions (logged as a party change); bad forms are refused", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const form = { questions: [{ id: "phone", label: "Phone", type: "text", required: true }], screenshot: "optional" };
    const r = await h.req("/api/tickets/form", api(os, { form }));
    expect(r.status).toBe(200);
    const p = await env.DB.prepare("SELECT rev, logged_rev, last_action FROM parties WHERE id = ?").bind(party).first();
    expect(p).toEqual({ rev: 2, logged_rev: 2, last_action: "guest_form_changed" });
    expect(((await (await h.req(`/api/guest/parties/${party}`)).json()) as { form: unknown }).form).toEqual({ ...form, questions: [{ ...form.questions[0], required: true }], id_photo: "none", instagram: "none" });
    for (const bad of [{ questions: [{ id: "A B", label: "x", type: "text" }] }, { questions: [{ id: "a", label: "x", type: "choice" }] }, { screenshot: "maybe" },
      { questions: [{ id: "a", label: "x", type: "text" }, { id: "a", label: "y", type: "text" }] }]) {
      expect((await h.req("/api/tickets/form", api(os, { form: bad }))).status, JSON.stringify(bad)).toBe(400);
    }
  });
});

describe("rows read and written (local measurement)", () => {
  it("sign-up, approval, release, scan of a new ticket", async () => {
    const h = await harness();
    const { party, os } = await openParty(h);
    const door = await seedDoor(party, h.clock);
    // Some other tickets in the party, so the capacity sum reads more than one row.
    for (let i = 0; i < 9; i++) await signup(h, party);
    logs = [];
    const s = await signup(h, party);
    const su = lastReq();
    const id = s.body.ticket_id!;
    await h.req("/api/tickets/approve", api(os, { ids: [id] }));
    const ap = lastReq();
    await h.req("/api/tickets/release", api(os, { ids: [id] }));
    const rl = lastReq();
    const qr = (await viewTicket(h, s.body.link!)).body.ticket!.qr!;
    const pg = lastReq();
    expect((await scan(h, door, qr)).verdict).toBe("admit");
    const sc = lastReq();
    const files = await env.FILES!.prepare("SELECT COUNT(*) AS n FROM files WHERE ticket_id = ?").bind(id).first("n");
    const pick = (r: ReqLog) => ({ queries: r.d1_queries, read: r.rows_read, written: r.rows_written, ledger_written: r.ledger_rows_written });
    console.error(JSON.stringify({ evt: "measure", what: "rows_per_guest_request_local", party_tickets: 10,
      signup: { ...pick(su), files_written: files }, approve: pick(ap), release: pick(rl), ticket_page: pick(pg), scan_admit: pick(sc) }));
    // An admission of a guest ticket still writes 2 main rows + 1 ledger row (the index is not touched by a scan).
    expect([sc.rows_written, sc.ledger_rows_written]).toEqual([2, 1]);
    expect(pg.rows_written).toBe(0);
    expect(su.ledger_rows_written).toBe(1);
  });
});

describe("static page headers", () => {
  it("only the sign-up page allows the Turnstile widget; every other page keeps the strict policy", () => {
    const h = env.TEST_ASSET_HEADERS;
    const rule = (path: string) => new RegExp(`^${path.replace(".", "\\.")}\\n  ! Content-Security-Policy\\n  Content-Security-Policy: [^\\n]*script-src 'self' https://challenges\\.cloudflare\\.com; frame-src https://challenges\\.cloudflare\\.com;`, "m");
    expect(h).toMatch(rule("/signup"));
    expect(h).toMatch(rule("/signup.html"));
    // Two rules of two mentions each, plus the comment above them.
    expect(h.match(/challenges\.cloudflare\.com/g)).toHaveLength(5);
    expect(h).toMatch(/^\/\*\n  Content-Security-Policy: default-src 'none'; script-src 'self'; /m);
  });
});

describe("owner-editable guest emails", () => {
  it("an owner rewrites the ticket email with placeholders; the link is required; defaults come back when cleared", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const edit = (b: Record<string, unknown>) => h.req("/api/party/details", api(os, b));
    // The link placeholder is required; unknown placeholders and emojis are refused.
    expect((await edit({ email_ticket_body: "Hi {guest_name}, see you there" })).status).toBe(400);
    expect((await edit({ email_ticket_body: "Hi {guest_name}: {link} {secret}" })).status).toBe(400);
    expect((await edit({ email_ticket_body: "Hi {guest_name} \u{1F389} {link}" })).status).toBe(400);
    const body = "Ahlan {guest_name}!\n\nYou're in for {party_name}. Your QR:\n{link}\n\n{people_note}\n\nSee you at the door.";
    expect((await edit({ email_ticket_subject: "{party_name}: you're in", email_ticket_body: body })).status).toBe(200);

    const s = await signup(h, party, { name: "Sara M", email: "sara@example.com", people: 2 });
    const id = s.body.ticket_id!;
    await h.req("/api/tickets/approve", api(os, { ids: [id] }));
    await h.req("/api/tickets/release", api(os, { ids: [id] }));
    const row = (await env.DB.prepare("SELECT subject, body_text FROM outbox WHERE kind = 'ticket_released' AND ticket_id = ?").bind(id).first<{ subject: string; body_text: string }>())!;
    expect(row.subject).toBe(`Party ${party}: you're in`);
    expect(row.body_text).toContain("Ahlan Sara M!");
    expect(row.body_text).toMatch(/\/ticket\.html#t=T1\./);
    expect(row.body_text).toContain("This QR admits 2 people together; arrive together.");
    // Cleared: back to the default text.
    expect((await edit({ email_ticket_subject: null, email_ticket_body: null })).status).toBe(200);
    const s2 = await signup(h, party, { email: "omar@example.com" });
    await h.req("/api/tickets/approve", api(os, { ids: [s2.body.ticket_id] }));
    await h.req("/api/tickets/release", api(os, { ids: [s2.body.ticket_id] }));
    const def = await env.DB.prepare("SELECT subject FROM outbox WHERE kind = 'ticket_released' AND ticket_id = ?").bind(s2.body.ticket_id).first<string>("subject");
    expect(def).toBe(`Your ticket for Party ${party}`);
    // The change log holds the edit (a party entity), so a recovery keeps it.
    const logged = await env.LEDGER.prepare("SELECT COUNT(*) AS n FROM change_log WHERE entity = 'party' AND entity_id = ? AND state LIKE '%Ahlan%'").bind(party).first("n");
    expect(Number(logged)).toBeGreaterThan(0);
  });
});
