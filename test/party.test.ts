// Party details (workstream A): address visibility for every mode and viewer,
// time zones, edits (owner/admin + CSRF, rules inside the statement), "Reveal now",
// the public view (zero writes), change log, outages and guest notices.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../src/lib/crypto";
import { visiblePartyDetails, type PartyDetailsRow, type Viewer } from "../src/party/details";
import { parseEdit } from "../src/party/input";
import { formatHuman, formatLocal, isTimeZone, zonedToUtc } from "../src/party/time";
import { api, harness, logEntry, OutageDriver, seedDoor, seedOwner, seedParty, seedSession, type Harness } from "./helpers";

const ADDRESS = "12 Secret Street, Zamalek";
const VENUE = "The Hidden Roof";
const MAP = "https://maps.example.com/?q=hidden";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
});
afterEach(() => {
  vi.restoreAllMocks();
  OutageDriver.down = { main: false, ledger: false };
});

type ReqLog = { route: string; method: string; status: number; d1_queries: number; rows_read: number; rows_written: number; ledger_rows_written: number };
function lastReq(): ReqLog {
  return JSON.parse(logs.filter((x) => x.startsWith('{"evt":"req"')).at(-1)!) as ReqLog;
}
/** Measured rows per request, reported in docs/DECISIONS.md (printed with console.warn). */
function measure(label: string) {
  const m = lastReq();
  console.warn(JSON.stringify({ evt: "party_measure", what: label, status: m.status, queries: m.d1_queries, rows_read: m.rows_read, rows_written: m.rows_written, ledger_rows_written: m.ledger_rows_written }));
  return m;
}

// ------------------------------------------------------------ pure visibility

const T0 = Date.UTC(2026, 9, 31, 18, 0);
function row(over: Partial<PartyDetailsRow> = {}): PartyDetailsRow {
  return {
    id: "p1", name: "Night", description: "d", starts_at: T0, ends_at: T0 + 6 * 3600_000, time_zone: "Africa/Cairo",
    venue_name: VENUE, address: ADDRESS, map_url: MAP, rules: "r", payment_instructions: "pay",
    capacity: 100, max_people_per_ticket: 2, address_mode: "with_ticket", reveal_at: null, revealed_at: null, address_locked_at: null,
    ...over,
  };
}
const good: Viewer = { kind: "ticket", status: "approved", released: true, onHold: false };
const viewers: [string, Viewer, boolean][] = [
  ["public", { kind: "public" }, false],
  ["approved released", good, true],
  ["approved not released", { ...good, released: false }, false],
  ["approved released on hold", { ...good, onHold: true }, false],
  ["pending released", { ...good, status: "pending" }, false],
  ["cancelled released", { ...good, status: "cancelled" }, false],
  ["rejected", { ...good, status: "rejected" }, false],
];

function expectHidden(v: ReturnType<typeof visiblePartyDetails>) {
  expect(v.address).toBeNull();
  expect(v.venue_name).toBeNull();
  expect(v.map_url).toBeNull();
  const s = JSON.stringify(v);
  for (const secret of [ADDRESS, VENUE, MAP, "Secret", "hidden"]) expect(s).not.toContain(secret);
}

describe("visiblePartyDetails", () => {
  it("public mode: every viewer sees the place", () => {
    for (const [label, viewer] of viewers) {
      const v = visiblePartyDetails(row({ address_mode: "public" }), viewer, T0);
      expect(v.address, label).toBe(ADDRESS);
      expect(v.venue_name, label).toBe(VENUE);
      expect(v.map_url, label).toBe(MAP);
      expect(v.reveal, label).toBeNull();
    }
  });

  it("with_ticket: only an approved, released ticket that is not on hold", () => {
    for (const [label, viewer, ok] of viewers) {
      const v = visiblePartyDetails(row(), viewer, T0);
      if (ok) {
        expect(v.address, label).toBe(ADDRESS);
        expect(v.reveal, label).toBeNull();
      } else {
        expectHidden(v);
        expect(v.reveal, label).toEqual({ mode: "with_ticket", waiting_for: "ticket" });
      }
    }
  });

  it("at_time: hidden before reveal_at (countdown), shown from reveal_at on, only to good tickets", () => {
    const at = T0 - 3600_000;
    const p = row({ address_mode: "at_time", reveal_at: at });
    for (const [label, viewer, ok] of viewers) {
      const before = visiblePartyDetails(p, viewer, at - 1);
      expectHidden(before);
      expect(before.reveal, label).toEqual({ mode: "at_time", at, waiting_for: ok ? "time" : "ticket" });
      const exactly = visiblePartyDetails(p, viewer, at);
      const after = visiblePartyDetails(p, viewer, at + 86_400_000);
      for (const v of [exactly, after]) {
        if (ok) expect(v.address, label).toBe(ADDRESS);
        else expectHidden(v);
      }
    }
    // Missing reveal time (should be impossible: the edit refuses it): never shown.
    expectHidden(visiblePartyDetails(row({ address_mode: "at_time", reveal_at: null }), good, T0 * 2));
  });

  it("at_time compares UTC instants; the party's time zone does not matter", () => {
    const at = zonedToUtc("2026-10-31T20:00", "Africa/Cairo")!;
    for (const tz of ["Africa/Cairo", "America/New_York", "Pacific/Kiritimati", "UTC"]) {
      const p = row({ address_mode: "at_time", reveal_at: at, time_zone: tz });
      expectHidden(visiblePartyDetails(p, good, at - 60_000));
      expect(visiblePartyDetails(p, good, at).address).toBe(ADDRESS);
    }
  });

  it("manual: hidden until revealed_at is set, then only to good tickets", () => {
    for (const [label, viewer, ok] of viewers) {
      const before = visiblePartyDetails(row({ address_mode: "manual" }), viewer, T0);
      expectHidden(before);
      expect(before.reveal, label).toEqual({ mode: "manual", waiting_for: ok ? "owner" : "ticket" });
      const after = visiblePartyDetails(row({ address_mode: "manual", revealed_at: T0 - 1 }), viewer, T0);
      if (ok) expect(after.address, label).toBe(ADDRESS);
      else expectHidden(after);
    }
  });

  it("an unknown mode is treated as the most closed one; extra columns never leak", () => {
    const p = { ...row({ address_mode: "bogus" }), secret_column: ADDRESS } as PartyDetailsRow;
    const v = visiblePartyDetails(p, good, T0);
    expectHidden(v);
    expect(v.address_mode).toBe("manual");
    expect(Object.keys(visiblePartyDetails(row({ address_mode: "public" }), good, T0)).sort()).toEqual([
      "address", "address_mode", "cancellation_policy", "description", "ends_at", "id", "max_people_per_ticket", "map_url", "name",
      "payment_instructions", "reveal", "review_time", "rules", "starts_at", "support", "time_zone", "venue_name",
    ].sort());
  });
});

describe("time zones", () => {
  it("validates IANA names", () => {
    for (const ok of ["Africa/Cairo", "UTC", "America/Argentina/Buenos_Aires", "Etc/GMT+2"]) expect(isTimeZone(ok), ok).toBe(true);
    for (const bad of ["Mars/Base", "+02:00", "", "Africa/Cairo; DROP", 3, null, "a".repeat(80)]) expect(isTimeZone(bad), String(bad)).toBe(false);
  });

  it("converts local wall time to UTC and back, across DST", () => {
    expect(zonedToUtc("2026-10-31T21:00", "Africa/Cairo")).toBe(Date.UTC(2026, 9, 31, 19, 0)); // Cairo winter UTC+2
    expect(zonedToUtc("2026-07-01T21:00", "Africa/Cairo")).toBe(Date.UTC(2026, 6, 1, 18, 0)); // summer UTC+3
    expect(zonedToUtc("2026-07-01T21:00", "UTC")).toBe(Date.UTC(2026, 6, 1, 21, 0));
    // New York: 02:30 on 8 March 2026 does not exist; 01:30 on 1 November 2026 happens twice (earlier chosen).
    expect(zonedToUtc("2026-03-08T02:30", "America/New_York")).toBeNull();
    expect(zonedToUtc("2026-11-01T01:30", "America/New_York")).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(zonedToUtc("2026-13-01T01:30", "UTC")).toBeNull();
    expect(zonedToUtc("2026-10-31 21:00", "UTC")).toBeNull();
    expect(formatLocal(Date.UTC(2026, 9, 31, 19, 0), "Africa/Cairo")).toBe("2026-10-31T21:00");
    expect(formatHuman(Date.UTC(2026, 9, 31, 19, 0), "Asia/Tokyo")).toBe("2026-11-01 04:00 (Asia/Tokyo)");
  });
});

describe("edit input", () => {
  it("refuses unsafe or malformed values", () => {
    const bad: Record<string, unknown>[] = [
      { map_url: "http://maps.example.com/x" }, { map_url: "javascript:alert(1)" }, { map_url: "https://user:pw@maps.example.com/" },
      { map_url: "data:text/html,x" }, { name: "" }, { name: "Party \u{1F389}" }, { address: "x".repeat(301) },
      { time_zone: "Mars/Base" }, { starts_at: 1_700_000_000 }, { starts_at: "2026-10-31" }, { address_mode: "secret" },
      { capacity: -1 }, { capacity: 1.5 }, { max_people_per_ticket: 0 }, { starts_at_local: "2026-10-31T21:00" },
      { surprise: 1 }, {}, { notify_guests: "yes", name: "x" }, { description: "a\u0000b" },
    ];
    for (const b of bad) expect(parseEdit(b).ok, JSON.stringify(b)).toBe(false);
    const ok = parseEdit({ starts_at_local: "2026-10-31T21:00", time_zone: "Africa/Cairo", map_url: "https://maps.example.com/?q=a b", description: "" });
    expect(ok).toEqual({ ok: true, notify: false, values: {
      starts_at: Date.UTC(2026, 9, 31, 19, 0), time_zone: "Africa/Cairo", map_url: "https://maps.example.com/?q=a%20b", description: null,
    } });
  });
});

// ----------------------------------------------------------------- routes

async function setup() {
  const h = await harness();
  const party = await seedParty();
  const owner = await seedOwner(party);
  const os = await seedSession(party, owner.id, "owner", h.clock);
  return { h, party, owner, os };
}

async function edit(h: Harness, sess: { token: string; csrf: string }, body: Record<string, unknown>) {
  const r = await h.req("/api/party/details", api(sess, body));
  return { status: r.status, body: (await r.json()) as Record<string, any> };
}

async function partyRow(id: string) {
  return (await env.DB.prepare("SELECT * FROM parties WHERE id = ?").bind(id).first<Record<string, any>>())!;
}

async function seedTicket(partyId: string, o: { status?: string; people?: number; released?: boolean; email?: string | null; hold?: boolean } = {}) {
  const id = newId().replace(/-/g, "").slice(0, 16).toUpperCase();
  await env.DB.prepare(`INSERT INTO tickets (id, party_id, status, people, guest_name, guest_email, created_at, released_at, hold_at, logged_rev)
    VALUES (?, ?, ?, ?, 'Guest', ?, 1, ?, ?, 1)`)
    .bind(id, partyId, o.status ?? "approved", o.people ?? 1, o.email === undefined ? `${id.toLowerCase()}@example.com` : o.email,
      o.released === false ? null : 1, o.hold ? 1 : null).run();
  return id;
}

const FULL = {
  name: "Halloween Night", description: "Costumes", venue_name: VENUE, address: ADDRESS, map_url: MAP,
  time_zone: "Africa/Cairo", starts_at_local: "2026-10-31T21:00", ends_at_local: "2026-11-01T03:00",
  rules: "No phones on the dance floor", payment_instructions: "InstaPay to the organiser", address_mode: "with_ticket",
};

describe("party details routes", () => {
  it("edit: owner and admin only, with same-origin CSRF", async () => {
    const { h, party } = await setup();
    const admin = await seedOwner(party, `a-${newId()}`, "admin");
    const as = await seedSession(party, admin.id, "admin", h.clock);
    const door = await seedDoor(party, h.clock);
    expect((await edit(h, door, { name: "Door rename" })).status).toBe(403);
    const noCsrf = api(as, { name: "x" });
    (noCsrf.headers as Record<string, string>)["x-sahra-csrf"] = "nope";
    expect((await h.req("/api/party/details", noCsrf)).status).toBe(403);
    const badOrigin = api(as, { name: "x" });
    (badOrigin.headers as Record<string, string>).origin = "https://evil.example";
    expect((await h.req("/api/party/details", badOrigin)).status).toBe(403);
    expect((await partyRow(party)).name).toBe(`Party ${party}`);
    const r = await edit(h, as, { name: "Admin rename" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("changed");
    expect((await partyRow(party)).name).toBe("Admin rename");
  });

  it("full edit: rev + audit + change log entry holding the new state; a repeat writes nothing", async () => {
    const { h, party, os } = await setup();
    const r = await edit(h, os, FULL);
    expect(r.status).toBe(200);
    const m = measure("edit_details_full");
    expect(m.rows_written).toBeGreaterThan(0);
    expect(r.body.party).toMatchObject({ address: ADDRESS, address_mode: "with_ticket", starts_at: Date.UTC(2026, 9, 31, 19, 0), ends_at: Date.UTC(2026, 10, 1, 1, 0) });
    const p = await partyRow(party);
    expect(p.rev).toBe(2);
    expect(p.logged_rev).toBe(2);
    expect(p.last_action).toBe("party_edited");
    const entry = await logEntry("party", party, 2);
    expect(entry!.state).toMatchObject({ address: ADDRESS, venue_name: VENUE, map_url: MAP, time_zone: "Africa/Cairo", address_mode: "with_ticket", name: "Halloween Night" });
    const a = await env.DB.prepare("SELECT action, detail, entity_rev FROM audit WHERE entity_id = ? AND action = 'party_edited'").bind(party).all();
    expect(a.results).toEqual([{ action: "party_edited", detail: expect.stringContaining("address"), entity_rev: 2 }]);

    const again = await edit(h, os, FULL);
    expect(again.body.status).toBe("already");
    const m2 = measure("edit_details_repeat_no_change");
    expect(m2.rows_written).toBe(0);
    expect(m2.ledger_rows_written).toBe(0);
    expect((await partyRow(party)).rev).toBe(2);
  });

  it("GET: owner sees settings, door sees name, times and place whatever the mode", async () => {
    const { h, party, os } = await setup();
    await edit(h, os, { ...FULL, address_mode: "manual" });
    const door = await seedDoor(party, h.clock);
    const d = await (await h.req("/api/party", { cookies: { "__Host-sahra_s": door.token } })).json();
    expect(d).toEqual({ id: party, name: "Halloween Night", starts_at: Date.UTC(2026, 9, 31, 19, 0), ends_at: Date.UTC(2026, 10, 1, 1, 0),
      time_zone: "Africa/Cairo", venue_name: VENUE, address: ADDRESS, map_url: MAP,
      // The organiser's number, so door staff can call during a problem (brainstorm idea 16).
      support: { phone: "+20 100 000 0001", email: null, note: null } });
    measure("get_details_door");
    const o = (await (await h.req("/api/party", { cookies: { "__Host-sahra_s": os.token } })).json()) as Record<string, unknown>;
    expect(o).toMatchObject({ address_mode: "manual", revealed_at: null, capacity: 300, payment_instructions: "InstaPay to the organiser" });
  });

  it("capacity can never go below the places held (pending + approved people), checked in the statement", async () => {
    const { h, party, os } = await setup();
    await seedTicket(party, { people: 3 });
    await seedTicket(party, { status: "pending", people: 2, released: false });
    await seedTicket(party, { status: "cancelled", people: 4 });
    await seedTicket(party, { status: "rejected", people: 4 });
    const low = await edit(h, os, { capacity: 4 });
    expect(low).toEqual({ status: 409, body: { error: "capacity_below_held", held: 5 } });
    measure("edit_capacity_refused");
    expect((await partyRow(party)).capacity).toBe(300);
    const ok = await edit(h, os, { capacity: 5, max_people_per_ticket: 3 });
    expect(ok.status).toBe(200);
    measure("edit_capacity_ok");
    expect(await partyRow(party)).toMatchObject({ capacity: 5, max_people_per_ticket: 3 });
  });

  it("race: a ticket held between the check and the edit still cannot push capacity below held", async () => {
    // Two requests at once: a capacity cut and a new held ticket. D1 runs each batch as one
    // transaction, so whichever order they commit in, capacity >= held after the edit.
    const { h, party, os } = await setup();
    await seedTicket(party, { people: 3 });
    const [r] = await Promise.all([edit(h, os, { capacity: 3 }), seedTicket(party, { people: 1 })]);
    const held = (await env.DB.prepare("SELECT SUM(people) AS n FROM tickets WHERE party_id = ? AND status IN ('pending','approved')").bind(party).first<{ n: number }>())!.n;
    const cap = (await partyRow(party)).capacity as number;
    if (r.status === 200) expect(cap).toBe(3);
    else expect(r.body).toEqual({ error: "capacity_below_held", held: 4 });
    // The held ticket may have committed after the cut (sign-up's own capacity check is workstream C);
    // the edit itself never sets capacity below what was held when it ran.
    expect(held).toBe(4);
  });

  it("two edits at once both apply; the change log holds the resulting state", async () => {
    const { h, party, os } = await setup();
    const [a, b] = await Promise.all([edit(h, os, { description: "A" }), edit(h, os, { rules: "B" })]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const p = await partyRow(party);
    expect(p).toMatchObject({ description: "A", rules: "B", rev: 3, logged_rev: 3 });
    expect((await logEntry("party", party, 3))!.state).toMatchObject({ description: "A", rules: "B" });
  });

  it("end before start and at_time without a reveal time are refused, also against stored values", async () => {
    const { h, party, os } = await setup();
    await edit(h, os, FULL);
    expect(await edit(h, os, { ends_at: Date.UTC(2026, 9, 31, 18, 0) })).toEqual({ status: 400, body: { error: "end_before_start" } });
    expect(await edit(h, os, { address_mode: "at_time" })).toEqual({ status: 400, body: { error: "reveal_time_required" } });
    expect((await partyRow(party)).rev).toBe(2);
    const ok = await edit(h, os, { address_mode: "at_time", time_zone: "Africa/Cairo", reveal_at_local: "2026-10-31T18:00" });
    expect(ok.status).toBe(200);
    expect((await partyRow(party)).reveal_at).toBe(Date.UTC(2026, 9, 31, 16, 0));
    // Clearing the reveal time while in at_time mode is refused too.
    expect(await edit(h, os, { reveal_at: null })).toEqual({ status: 400, body: { error: "reveal_time_required" } });
  });

  it("address lock: the place and the lock freeze once it passes; other fields stay editable", async () => {
    const { h, party, os } = await setup();
    await edit(h, os, { ...FULL, address_locked_at: h.clock.now() + 600_000 });
    expect((await edit(h, os, { address: "Before lock" })).status).toBe(200);
    h.clock.advance(1_200_000);
    for (const b of [{ address: "After lock" }, { venue_name: "Other" }, { map_url: "https://maps.example.com/other" }, { address_locked_at: null },
      { address_locked_at: h.clock.now() + 86_400_000 }, { description: "fine", address: null }]) {
      expect(await edit(h, os, b), JSON.stringify(b)).toEqual({ status: 409, body: { error: "address_locked" } });
    }
    expect((await partyRow(party)).address).toBe("Before lock");
    expect((await edit(h, os, { description: "Still editable", address_mode: "public" })).status).toBe(200);
    // Sending the same place again is not a change.
    expect((await edit(h, os, { address: "Before lock" })).body.status).toBe("already");
  });

  it("reveal now: manual mode only; idempotent; two presses at once reveal once", async () => {
    const { h, party, os } = await setup();
    await edit(h, os, FULL);
    expect(await (await h.req("/api/party/reveal", api(os))).json()).toEqual({ error: "not_manual_mode" });
    await edit(h, os, { address_mode: "manual" });
    const before = await (await h.req(`/api/party/public/${party}`)).json();
    expect(JSON.stringify(before)).not.toContain("Secret");
    const [a, b] = await Promise.all([h.req("/api/party/reveal", api(os)), h.req("/api/party/reveal", api(os))]);
    const statuses = [((await a.json()) as { status: string }).status, ((await b.json()) as { status: string }).status].sort();
    expect(statuses).toEqual(["already", "revealed"]);
    measure("reveal_now_second_of_two");
    const p = await partyRow(party);
    expect(p.revealed_at).toBe(h.clock.now());
    expect(p.rev).toBe(p.logged_rev);
    expect((await logEntry("party", party, p.rev))!.state).toMatchObject({ revealed_at: h.clock.now(), last_action: "address_revealed" });
    // Ticket holders now see it (preview), the public still does not.
    expect((await (await h.req("/api/party/reveal", api(os))).json() as { status: string }).status).toBe("already");
    measure("reveal_now_repeat");
    const t = await (await h.req("/api/party/preview?viewer=ticket&status=approved&released=1&on_hold=0", { cookies: { "__Host-sahra_s": os.token } })).json();
    expect(t).toMatchObject({ address: ADDRESS, reveal: null });
    const pub = await (await h.req(`/api/party/public/${party}`)).json();
    expect(pub).toMatchObject({ address: null, venue_name: null, map_url: null, reveal: { mode: "manual", waiting_for: "ticket" } });
    const door = await seedDoor(party, h.clock);
    expect((await h.req("/api/party/reveal", api(door))).status).toBe(403);
  });

  it("public view: no session, zero writes, place only in public mode", async () => {
    const { h, party, os } = await setup();
    await edit(h, os, { ...FULL, address_mode: "at_time", reveal_at: h.clock.now() - 1 });
    const r = await h.req(`/api/party/public/${party}`);
    expect(r.status).toBe(200);
    const text = await r.text();
    for (const s of [ADDRESS, VENUE, MAP]) expect(text).not.toContain(s);
    expect(JSON.parse(text)).toMatchObject({ name: "Halloween Night", reveal: { mode: "at_time", at: h.clock.now() - 1, waiting_for: "ticket" } });
    const m = measure("public_view");
    expect(m.rows_written).toBe(0);
    expect(m.ledger_rows_written).toBe(0);
    await edit(h, os, { address_mode: "public" });
    expect(await (await h.req(`/api/party/public/${party}`)).json()).toMatchObject({ address: ADDRESS, venue_name: VENUE, map_url: MAP, reveal: null });
    expect((await h.req("/api/party/public/nope")).status).toBe(404);
    expect((await h.req("/api/party/public/" + encodeURIComponent("x' OR 1=1"))).status).toBe(404);
  });

  it("ledger unreachable: edit answers pending, nothing confirmed; the retry completes it", async () => {
    const { h, party, os } = await setup();
    OutageDriver.down.ledger = true;
    const r = await edit(h, os, { address: ADDRESS, address_mode: "public" });
    expect(r).toEqual({ status: 503, body: { status: "pending", error: "not_recorded_yet", retry: true } });
    OutageDriver.down.ledger = false;
    let p = await partyRow(party);
    expect(p.rev).toBe(2);
    expect(p.logged_rev).toBe(1);
    expect(await logEntry("party", party, 2)).toBeNull();
    const retry = await edit(h, os, { address: ADDRESS, address_mode: "public" });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("already");
    p = await partyRow(party);
    expect(p).toMatchObject({ rev: 2, logged_rev: 2 });
    expect((await logEntry("party", party, 2))!.state).toMatchObject({ address: ADDRESS, address_mode: "public" });
  });

  it("main database unreachable: 503 and nothing changes", async () => {
    const { h, party, os } = await setup();
    OutageDriver.down.main = true;
    expect((await edit(h, os, { name: "Never" })).status).toBe(503);
    expect((await h.req(`/api/party/public/${party}`)).status).toBe(503);
    OutageDriver.down.main = false;
    expect((await partyRow(party)).name).toBe(`Party ${party}`);
  });

  it("notify guests: one outbox row per approved, released ticket with an email, awaiting approval, without the place", async () => {
    const { h, party, os } = await setup();
    await edit(h, os, FULL);
    const t1 = await seedTicket(party);
    const t2 = await seedTicket(party, { hold: true });
    await seedTicket(party, { released: false });
    await seedTicket(party, { status: "pending", released: false });
    await seedTicket(party, { status: "cancelled" });
    await seedTicket(party, { email: null });
    expect((await edit(h, os, { description: "x", notify_guests: true })).body).toEqual({ error: "notify_needs_time_or_place_change" });
    const r = await edit(h, os, { address: "New place 1", starts_at_local: "2026-10-31T22:00", time_zone: "Africa/Cairo", notify_guests: true });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: "changed", notices_queued: 2, notices_not_queued: 0 });
    const m = measure("edit_with_notice_2_guests");
    const rows = (await env.DB.prepare("SELECT ticket_id, kind, status, subject, body_text, to_email FROM outbox WHERE party_id = ? ORDER BY ticket_id").bind(party).all<Record<string, string>>()).results;
    expect(rows.map((x) => x.ticket_id).sort()).toEqual([t1, t2].sort());
    for (const x of rows) {
      expect(x).toMatchObject({ kind: "party_notice", status: "awaiting_approval", subject: "Update: Halloween Night" });
      expect(x.body_text).toContain("Starts: 2026-10-31 22:00 (Africa/Cairo)");
      expect(x.body_text).not.toContain("New place");
      expect(x.body_text).not.toContain(VENUE);
    }
    expect(m.rows_written).toBeGreaterThanOrEqual(2);
    // A retry of the same edit queues nothing more.
    const again = await edit(h, os, { address: "New place 1", starts_at_local: "2026-10-31T22:00", time_zone: "Africa/Cairo", notify_guests: true });
    expect(again.body.status).toBe("already");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id = ?").bind(party).first("n"))).toBe(2);
    // A refused edit queues nothing.
    h.clock.advance(1);
    await edit(h, os, { address_locked_at: h.clock.now() });
    h.clock.advance(1);
    expect((await edit(h, os, { address: "Locked out", notify_guests: true })).status).toBe(409);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id = ?").bind(party).first("n"))).toBe(2);
  });

  it("preview validates its viewer", async () => {
    const { h, os } = await setup();
    expect((await h.req("/api/party/preview?viewer=x", { cookies: { "__Host-sahra_s": os.token } })).status).toBe(400);
    expect((await h.req("/api/party/preview?viewer=public&at=abc", { cookies: { "__Host-sahra_s": os.token } })).status).toBe(400);
  });
});
