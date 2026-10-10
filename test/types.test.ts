// Ticket types (names, prices, places, sales windows, entry times, staff-only),
// registration rules (open/close times, tickets per email, duplicate warning),
// staff-issued tickets, guest search and resend, announcements, and the stats.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../src/lib/crypto";
import { api, guestParty, harness, logEntry, openParty, scan, seedDoor, seedOwner, seedSession, signup, viewTicket, type Harness } from "./helpers";

let logs: string[] = [];
beforeEach(() => {
  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => { logs.push(String(a[0])); });
});
afterEach(() => { vi.restoreAllMocks(); });

type Sess = { token: string; csrf: string };
type ReqLog = { route: string; rows_written: number; ledger_rows_written: number };
const lastReq = () => logs.filter((x) => x.startsWith('{"evt":"req"')).map((l) => JSON.parse(l) as ReqLog).at(-1)!;

async function newType(h: Harness, os: Sess, b: Record<string, unknown>) {
  const r = await h.req("/api/tickets/types", api(os, { op: newId(), ...b }));
  return { status: r.status, body: (await r.json()) as { status?: string; type?: { id: string; price: number; rev: number }; error?: string; held?: number } };
}
async function editType(h: Harness, os: Sess, id: string, b: Record<string, unknown>) {
  const r = await h.req(`/api/tickets/types/${id}`, api(os, b));
  return { status: r.status, body: (await r.json()) as { status?: string; error?: string; held?: number } };
}
async function ticket(id: string) {
  return env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first<Record<string, unknown>>();
}
async function form(h: Harness, party: string) {
  return (await (await h.req(`/api/guest/parties/${party}`)).json()) as {
    types: { id: string; name: string; price: number; places_left: number; on_sale: boolean; sold_out: boolean; payment_instructions: string | null }[];
    registration: { open: boolean; state: string }; max_tickets_per_email: number | null;
  };
}
async function typedSignup(h: Harness, party: string, typeId: string | null, f: Parameters<typeof signup>[2] = {}) {
  // The helper builds the multipart body; the type goes in as one more field.
  const { signupInit } = await import("./helpers");
  const init = await signupInit(f);
  const body = init.body as Uint8Array;
  const boundary = /boundary=(.*)$/.exec((init.headers as Record<string, string>)["content-type"]!)![1]!;
  const extra = typeId === null ? "" : `--${boundary}\r\nContent-Disposition: form-data; name="type_id"\r\n\r\n${typeId}\r\n`;
  const full = new Uint8Array([...new TextEncoder().encode(extra), ...body]);
  const res = await h.req(`/api/guest/parties/${party}/signup`, {
    ...init, body: full, headers: { ...(init.headers as Record<string, string>), "content-length": String(full.length) },
  });
  return { status: res.status, body: (await res.json()) as { ticket_id?: string; link?: string; error?: string; earlier_requests?: number; notice?: string } };
}
async function release(h: Harness, os: Sess, id: string) {
  expect((await (await h.req("/api/tickets/approve", api(os, { ids: [id] }))).json())).toEqual({ results: { [id]: "done" } });
  expect((await (await h.req("/api/tickets/release", api(os, { ids: [id] }))).json())).toEqual({ results: { [id]: "done" } });
}

describe("ticket types", () => {
  it("owner creates priced types; logged, audited, and a retry with the same op is the same type", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const op = newId();
    const r = await h.req("/api/tickets/types", api(os, { op, name: "Early", price: 250, quantity: 50 }));
    expect(r.status).toBe(201);
    const t = ((await r.json()) as { type: { id: string; name: string; price: number; quantity: number; rev: number; logged_rev: number } }).type;
    expect(t).toMatchObject({ name: "Early", price: 250, quantity: 50, rev: 1, logged_rev: 1 });
    expect((await logEntry("ticket_type", t.id, 1) as { action?: string } | null)?.action).toBe("type_created");
    expect(await env.DB.prepare("SELECT action FROM audit WHERE entity_type = 'ticket_type' AND entity_id = ?").bind(t.id).first("action")).toBe("type_created");
    const again = await h.req("/api/tickets/types", api(os, { op, name: "Early", price: 250, quantity: 50 }));
    expect([again.status, ((await again.json()) as { status: string }).status]).toEqual([200, "already"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ticket_types WHERE party_id = ?").bind(party).first("n")).toBe(1);
    const list = (await (await h.req("/api/tickets/types", { ...api(os), method: "GET" })).json()) as { currency: string; types: { name: string; held: number; places_left: number }[] };
    expect(list).toMatchObject({ currency: "EGP", types: [{ name: "Early", held: 0, places_left: 50 }] });
  });

  it("refuses bad input, a sales window that closes before it opens, and places below the people holding them", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    for (const bad of [{ name: "" }, { name: "Early", price: -1 }, { name: "Early", price: 1.5 }, { name: "\u{1F389}" },
      { name: "Early", quantity: 0 }, { name: "Early", colour: "red" }, { name: "Early", staff_only: "yes" }]) {
      expect((await newType(h, os, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    const now = h.clock.now();
    expect((await newType(h, os, { name: "Early", sales_opens_at: now + 3600_000, sales_closes_at: now })).body.error).toBe("sales_close_before_open");
    // *_local needs the party's time zone.
    expect((await newType(h, os, { name: "Early", entry_from_local: "2026-10-31T21:00" })).body.error).toBe("party_time_zone_not_set");
    await env.DB.prepare("UPDATE parties SET time_zone = 'Africa/Cairo' WHERE id = ?").bind(party).run();
    const local = await newType(h, os, { name: "Late", entry_from_local: "2026-10-31T21:00" });
    expect(local.status).toBe(201);
    expect(await env.DB.prepare("SELECT entry_from FROM ticket_types WHERE id = ?").bind(local.body.type!.id).first("entry_from"))
      .toBe(Date.UTC(2026, 9, 31, 19, 0)); // Egypt's summer time ends on 29 October 2026: UTC+2

    const vip = (await newType(h, os, { name: "VIP", price: 900, quantity: 5 })).body.type!.id;
    expect((await typedSignup(h, party, vip, { people: 3 })).status).toBe(201);
    expect(await editType(h, os, vip, { quantity: 2 })).toEqual({ status: 409, body: { error: "quantity_below_held", held: 3 } });
    expect((await editType(h, os, vip, { quantity: 3, price: 1000 })).body.status).toBe("changed");
    expect((await editType(h, os, vip, { quantity: 3, price: 1000 })).body.status).toBe("already");
    expect((await editType(h, os, "AAAAAAAAAAAAAAAA", { price: 1 })).status).toBe(404);
  });

  it("archive stops new requests (existing tickets keep their type); restore counts against the 20 active types", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const early = (await newType(h, os, { name: "Early", price: 100 })).body.type!.id;
    const s = await typedSignup(h, party, early);
    expect(s.status).toBe(201);
    expect((await editType(h, os, early, { archived: true })).body.status).toBe("changed");
    expect((await ticket(s.body.ticket_id!))!.type_id).toBe(early);
    // No active public types left: untyped requests work again.
    expect((await typedSignup(h, party, early)).body.error).toBe("type_unavailable");
    expect((await typedSignup(h, party, null)).status).toBe(201);
    for (let i = 0; i < 20; i++) expect((await newType(h, os, { name: `T${i}` })).status).toBe(201);
    expect((await newType(h, os, { name: "One too many" })).body.error).toBe("too_many_types");
    expect((await editType(h, os, early, { archived: false })).body.error).toBe("too_many_types");
  });

  it("a change-log flush does not read the logged types (partial index), however many there are", async () => {
    const h = await harness();
    const { os } = await guestParty(h);
    const editReads = async (name: string) => {
      logs = [];
      expect((await h.req("/api/party/details", api(os, { name }))).status).toBe(200);
      return (JSON.parse(logs.filter((x) => x.startsWith('{"evt":"req"')).at(-1)!) as { rows_read: number }).rows_read;
    };
    await newType(h, os, { name: "First" });
    const before = await editReads("One");
    for (let i = 0; i < 15; i++) await newType(h, os, { name: `T${i}` });
    expect(await editReads("Two")).toBe(before);
  });

  it("the flush does not read logged parties, staff or invites either (migrations/0015)", async () => {
    const h = await harness();
    const { os } = await guestParty(h);
    const editReads = async (name: string) => {
      logs = [];
      expect((await h.req("/api/party/details", api(os, { name }))).status).toBe(200);
      return (JSON.parse(logs.filter((x) => x.startsWith('{"evt":"req"')).at(-1)!) as { rows_read: number }).rows_read;
    };
    const before = await editReads("One");
    // 30 more parties, each with a staff member and an invitation, all already logged.
    const stmts: D1PreparedStatement[] = [];
    for (let i = 0; i < 30; i++) {
      const p = `x${newId().slice(0, 8)}`;
      const st = newId();
      stmts.push(env.DB.prepare("INSERT INTO parties (id, name, capacity, created_at, rev, logged_rev) VALUES (?, 'X', 10, 1, 1, 1)").bind(p));
      stmts.push(env.DB.prepare("INSERT INTO staff (id, party_id, name, role, created_at, rev, logged_rev) VALUES (?, ?, 'S', 'door', 1, 1, 1)").bind(st, p));
      stmts.push(env.DB.prepare("INSERT INTO invites (id, party_id, staff_id, kind, role, token_hash, created_at, expires_at, rev, logged_rev) VALUES (?, ?, ?, 'door', 'door', ?, 1, 2, 1, 1)")
        .bind(newId(), p, st, newId()));
    }
    await env.DB.batch(stmts);
    expect(await editReads("Two")).toBe(before);
  });

  it("door staff cannot manage types", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const door = await seedDoor(party, h.clock);
    expect((await h.req("/api/tickets/types", api(door, { op: newId(), name: "Early" }))).status).toBe(403);
    expect((await h.req("/api/tickets/types", { ...api(door), method: "GET" })).status).toBe(403);
  });
});

describe("sign-up with ticket types", () => {
  it("the form lists public types with price and places; a type is required, on sale, not staff-only, and its places hold", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { capacity: 10 });
    const now = h.clock.now();
    const early = (await newType(h, os, { name: "Early", price: 200, quantity: 2, sales_closes_at: now + 3600_000, payment_instructions: "Instapay to 010", sort: 1 })).body.type!.id;
    const regular = (await newType(h, os, { name: "Regular", price: 300, sales_opens_at: now + 1800_000, sort: 2 })).body.type!.id;
    const comp = (await newType(h, os, { name: "Guest list", staff_only: true })).body.type!.id;
    const f = await form(h, party);
    expect(f.types.map((t) => [t.name, t.price, t.places_left, t.on_sale])).toEqual([["Early", 200, 2, true], ["Regular", 300, 10, false]]);
    // The public party details come with the form; a hidden place is not in them.
    await env.DB.prepare("UPDATE parties SET address = 'Street 90', venue_name = 'Apt 12', address_mode = 'with_ticket' WHERE id = ?").bind(party).run();
    const withDetails = (await (await h.req(`/api/guest/parties/${party}`)).json()) as { details: Record<string, unknown> };
    expect(withDetails.details).toMatchObject({ id: party, address: null, venue_name: null, reveal: { mode: "with_ticket", waiting_for: "ticket" } });
    expect(JSON.stringify(withDetails)).not.toContain("Street 90");
    expect(f.types[0]!.payment_instructions).toBe("Instapay to 010");

    expect((await typedSignup(h, party, null)).body.error).toBe("type_required");
    expect((await typedSignup(h, party, comp)).body.error).toBe("type_unavailable");
    expect((await typedSignup(h, party, regular)).body.error).toBe("type_unavailable");
    const a = await typedSignup(h, party, early, { people: 2 });
    expect(a.status).toBe(201);
    expect(await ticket(a.body.ticket_id!)).toMatchObject({ type_id: early, price: 200, people: 2 });
    expect((await typedSignup(h, party, early)).body.error).toBe("type_full");
    expect((await form(h, party)).types[0]).toMatchObject({ places_left: 0, sold_out: true, on_sale: false });
    // Sales windows move with time.
    h.clock.advance(3600_000);
    expect((await typedSignup(h, party, early)).body.error).toBe("type_unavailable");
    const b = await typedSignup(h, party, regular);
    expect(b.status).toBe(201);
    expect((await ticket(b.body.ticket_id!))!.price).toBe(300);
    // A later price change does not change what earlier guests were shown.
    await editType(h, os, regular, { price: 350 });
    expect((await ticket(b.body.ticket_id!))!.price).toBe(300);
  });

  it("the type's places are checked again inside the insert (two parties' rules never mix)", async () => {
    const h = await harness();
    const one = await guestParty(h);
    const two = await guestParty(h);
    const t1 = (await newType(h, one.os, { name: "Early" })).body.type!.id;
    // A type of another party is not a type of this one.
    expect((await typedSignup(h, two.party, t1)).body.error).toBe("type_unavailable");
    expect((await typedSignup(h, one.party, t1)).status).toBe(201);
  });

  it("approval respects the type's places even if they were lowered behind its back", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const early = (await newType(h, os, { name: "Early", quantity: 2 })).body.type!.id;
    const ids = [(await typedSignup(h, party, early)).body.ticket_id!, (await typedSignup(h, party, early)).body.ticket_id!];
    await env.DB.prepare("UPDATE ticket_types SET quantity = 1 WHERE id = ?").bind(early).run();
    const r = (await (await h.req("/api/tickets/approve", api(os, { ids }))).json()) as { results: Record<string, string> };
    expect(Object.values(r.results).sort()).toEqual(["done", "refused"]);
  });

  it("parties without types work as before", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    expect((await form(h, party)).types).toEqual([]);
    const s = await typedSignup(h, party, null);
    expect(s.status).toBe(201);
    expect(await ticket(s.body.ticket_id!)).toMatchObject({ type_id: null, price: null });
  });
});

describe("registration rules", () => {
  it("requests only between the opening and closing times", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const now = h.clock.now();
    const edit = (b: Record<string, unknown>) => h.req("/api/party/details", api(os, b));
    expect((await edit({ registration_opens_at: now + 3600_000, registration_closes_at: now })).status).toBe(400);
    expect((await edit({ registration_opens_at: now + 3600_000, registration_closes_at: now + 7200_000 })).status).toBe(200);
    expect((await form(h, party)).registration).toMatchObject({ open: false, state: "not_open_yet" });
    const p = (await (await h.req("/api/party", { ...api(os), method: "GET" })).json()) as Record<string, unknown>;
    expect(p).toMatchObject({ registration_opens_at: now + 3600_000, registration_closes_at: now + 7200_000, max_tickets_per_email: null });
    expect((await typedSignup(h, party, null)).body.error).toBe("registration_not_open");
    h.clock.advance(3600_000);
    expect((await typedSignup(h, party, null)).status).toBe(201);
    h.clock.advance(3600_000);
    expect((await form(h, party)).registration.state).toBe("closed");
    expect((await typedSignup(h, party, null)).body.error).toBe("registration_closed");
  });

  it("max tickets per email (pending + approved), the duplicate warning, and the queue's same-email count", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    expect((await h.req("/api/party/details", api(os, { max_tickets_per_email: 2 }))).status).toBe(200);
    const email = "dup@example.com";
    const a = await typedSignup(h, party, null, { email });
    expect(a.body.earlier_requests).toBe(0);
    const b = await typedSignup(h, party, null, { email: "DUP@example.com" });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ earlier_requests: 1, notice: "This email already has 1 other request for this party." });
    expect((await typedSignup(h, party, null, { email })).body.error).toBe("email_limit");
    const q = (await (await h.req("/api/tickets", { ...api(os), method: "GET" })).json()) as { tickets: { id: string; same_email: number }[] };
    expect(q.tickets.map((t) => t.same_email)).toEqual([1, 1]);
    // A rejected request no longer counts.
    await h.req("/api/tickets/reject", api(os, { ids: [a.body.ticket_id] }));
    expect((await typedSignup(h, party, null, { email })).status).toBe(201);
    expect((await h.req("/api/party/details", api(os, { max_tickets_per_email: 0 }))).status).toBe(400);
  });
});

describe("door: entry time per type", () => {
  it("a ticket whose type enters later is refused (never green) until then, and the verdict says so", async () => {
    const h = await harness();
    const { party, os } = await openParty(h);
    await env.DB.prepare("UPDATE parties SET time_zone = 'Africa/Cairo' WHERE id = ?").bind(party).run();
    // A door session that outlives the hour this test waits.
    const door = await seedSession(party, (await seedDoor(party, h.clock)).id, "door", h.clock, 6 * 3600_000);
    const now = h.clock.now();
    const late = (await newType(h, os, { name: "Regular", entry_from: now + 3600_000 })).body.type!.id;
    const early = (await newType(h, os, { name: "Early" })).body.type!.id;
    const t1 = await typedSignup(h, party, late);
    const t2 = await typedSignup(h, party, early);
    await release(h, os, t1.body.ticket_id!);
    await release(h, os, t2.body.ticket_id!);
    const page1 = (await viewTicket(h, t1.body.link!)).body.ticket as unknown as { qr: string; type: string; entry_from: number };
    expect([page1.type, page1.entry_from]).toEqual(["Regular", now + 3600_000]);
    const qr1 = page1.qr;
    const qr2 = (await viewTicket(h, t2.body.link!)).body.ticket!.qr!;

    logs = [];
    const v = await scan(h, door, qr1);
    expect(v).toMatchObject({ verdict: "stop", reason: "too early: Regular enters from 2026-10-01 22:00 (Africa/Cairo)", type: "Regular" });
    expect([lastReq().rows_written, lastReq().ledger_rows_written]).toEqual([1, 0]);
    expect((await ticket(t1.body.ticket_id!))!.used_at).toBeNull();
    expect(await scan(h, door, qr2)).toMatchObject({ verdict: "admit", type: "Early" });
    expect([lastReq().rows_written, lastReq().ledger_rows_written]).toEqual([2, 1]);
    h.clock.advance(3600_000);
    expect(await scan(h, door, qr1)).toMatchObject({ verdict: "admit", type: "Regular" });
    expect(await scan(h, door, qr1)).toMatchObject({ verdict: "used", type: "Regular" });
  });
});

describe("staff-issued tickets", () => {
  it("issues a complimentary staff-only ticket, sends it at once, and a retry is the same ticket", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { capacity: 3 });
    const comp = (await newType(h, os, { name: "Guest list", staff_only: true, price: 500 })).body.type!.id;
    const op = newId();
    const body = { op, name: "DJ Friend", email: "dj@example.com", people: 2, type_id: comp, complimentary: true, release: true };
    const r = await h.req("/api/tickets/issue", api(os, body));
    expect(r.status).toBe(201);
    const j = (await r.json()) as { ticket_id: string; link: string };
    expect(await ticket(j.ticket_id)).toMatchObject({ status: "approved", people: 2, type_id: comp, price: 0, last_action: "ticket_issued", logged_rev: 1 });
    expect((await ticket(j.ticket_id))!.released_at).not.toBeNull();
    const mail = await env.DB.prepare("SELECT kind, to_email, status FROM outbox WHERE ticket_id = ?").bind(j.ticket_id).all();
    expect(mail.results).toEqual([{ kind: "ticket_released", to_email: "dj@example.com", status: "queued" }]);
    expect((await viewTicket(h, j.link)).body.ticket!.qr).toBeTruthy();
    const again = await h.req("/api/tickets/issue", api(os, body));
    expect([again.status, ((await again.json()) as { status: string }).status]).toEqual([200, "already"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ?").bind(party).first("n")).toBe(1);
    // Capacity holds for staff too.
    const full = await h.req("/api/tickets/issue", api(os, { op: newId(), name: "One more", people: 2 }));
    expect([full.status, ((await full.json()) as { error: string }).error]).toEqual([409, "full"]);
    const door = await seedDoor(party, h.clock);
    expect((await h.req("/api/tickets/issue", api(door, { op: newId(), name: "X" }))).status).toBe(403);
  });
});

describe("search, resend, announcements, stats", () => {
  it("staff find a guest by name, email or ticket id, and resend their ticket link once per 10 minutes", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const s = await typedSignup(h, party, null, { name: "Nour El Sherif", email: "nour@example.com" });
    await typedSignup(h, party, null, { name: "Omar", email: "omar@example.com" });
    const find = async (q: string) => ((await (await h.req(`/api/tickets/search?q=${encodeURIComponent(q)}`, { ...api(os), method: "GET" })).json()) as { tickets: { id: string }[] }).tickets.map((t) => t.id);
    expect(await find("el sher")).toEqual([s.body.ticket_id]);
    expect(await find("NOUR@")).toEqual([s.body.ticket_id]);
    expect(await find(s.body.ticket_id!)).toEqual([s.body.ticket_id]);
    expect(await find("%%")).toEqual([]);
    expect((await h.req("/api/tickets/search?q=a", { ...api(os), method: "GET" })).status).toBe(400);

    const resend = async () => (await (await h.req(`/api/tickets/${s.body.ticket_id}/resend`, api(os, {}))).json()) as { status: string; link: string };
    expect((await resend()).status).toBe("queued");
    expect((await resend()).status).toBe("already_queued");
    h.clock.advance(10 * 60_000);
    expect((await resend()).status).toBe("queued");
    const rows = await env.DB.prepare("SELECT kind, to_email FROM outbox WHERE ticket_id = ?").bind(s.body.ticket_id).all();
    expect(rows.results).toEqual([{ kind: "ticket_link", to_email: "nour@example.com" }, { kind: "ticket_link", to_email: "nour@example.com" }]);
    const door = await seedDoor(party, h.clock);
    expect((await h.req("/api/tickets/search?q=nour", { ...api(door), method: "GET" })).status).toBe(403);
  });

  it("an announcement queues one email per guest in the audience, awaiting approval; a retry queues nobody twice", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const a = await typedSignup(h, party, null, { email: "a@example.com" });
    await typedSignup(h, party, null, { email: "b@example.com" });
    await release(h, os, a.body.ticket_id!);
    const op = newId();
    const send = (b: Record<string, unknown>) => h.req("/api/party/announce", api(os, { op, subject: "Dress code", body: "All black.\nSee you!", ...b }));
    const r = await send({});
    expect((await r.json())).toEqual({ status: "awaiting_approval", queued: 1, not_queued: 0 });
    const row = await env.DB.prepare("SELECT kind, to_email, status, body_text FROM outbox WHERE party_id = ? AND kind = 'party_announcement'").bind(party).first();
    expect(row).toMatchObject({ kind: "party_announcement", to_email: "a@example.com", status: "awaiting_approval" });
    expect(String(row!.body_text)).toContain("All black.\nSee you!\n\nSent by the organisers of");
    expect(await (await send({})).json()).toEqual({ status: "awaiting_approval", queued: 1, not_queued: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE party_id = ? AND action = 'announcement_queued'").bind(party).first("n")).toBe(1);
    const all = await h.req("/api/party/announce", api(os, { op: newId(), subject: "Hi", body: "Hello all", audience: "everyone" }));
    expect(((await all.json()) as { queued: number }).queued).toBe(2);
    // An emoji-only subject is empty once emojis are taken out.
    expect((await h.req("/api/party/announce", api(os, { op: newId(), subject: "\u{1F389}", body: "x" }))).status).toBe(400);
    expect((await h.req("/api/party/announce", api(os, { op: newId(), subject: "Hi", body: "x", audience: "rejected" }))).status).toBe(400);
  });

  it("stats: places held and left, per type, check-ins per 10 minutes and per scanner; door staff may read them", async () => {
    const h = await harness();
    const { party, os } = await openParty(h);
    await env.DB.prepare("UPDATE parties SET max_people_per_ticket = 4 WHERE id = ?").bind(party).run();
    const door = await seedDoor(party, h.clock);
    const vip = (await newType(h, os, { name: "VIP", quantity: 5, price: 300 })).body.type!.id;
    const a = await typedSignup(h, party, vip, { people: 2 });
    await typedSignup(h, party, vip);
    await release(h, os, a.body.ticket_id!);
    expect((await scan(h, door, (await viewTicket(h, a.body.link!)).body.ticket!.qr!)).verdict).toBe("admit");
    const r = await h.req("/api/party/stats", { ...api(door), method: "GET" });
    expect(r.status).toBe(200);
    const s = (await r.json()) as Record<string, unknown> & { by_type: unknown[]; check_ins_per_15_min: unknown[]; by_scanner: unknown[]; requests_per_hour: unknown[] };
    const cap = Number(await env.DB.prepare("SELECT capacity FROM parties WHERE id = ?").bind(party).first("capacity"));
    expect(s).toMatchObject({ capacity: cap, held: 3, places_left: cap - 3, pending: 1, approved: 2, released: 2, inside: 2, admitted_tickets: 1,
      money_expected: 600, money_pending: 300, pending_requests: 1 });
    expect(s.by_type).toEqual([{ type_id: vip, name: "VIP", quantity: 5, pending: 1, approved: 2, released: 2, admitted: 2, places_left: 2 }]);
    expect(s.check_ins_per_15_min).toEqual([{ at: Math.floor(h.clock.now() / 900_000) * 900_000, tickets: 1, people: 2 }]);
    expect(s.requests_per_hour).toEqual([{ at: Math.floor(h.clock.now() / 3_600_000) * 3_600_000, requests: 2, people: 3 }]);
    expect(s.by_scanner).toMatchObject([{ staff_id: door.id, tickets: 1, people: 2 }]);
  });
});

describe("roles", () => {
  it("an admin (not owner) can manage types too", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const admin = await seedOwner(party, undefined, "admin");
    const as = await seedSession(party, admin.id, "admin", h.clock);
    expect((await newType(h, as, { name: "Early" })).status).toBe(201);
  });
});
