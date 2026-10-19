// Several separate tickets in one request (migrations/0022_ticket_orders.sql): each
// ticket has its own link and QR code, all are created or none, the whole order is
// counted against capacity, type places and the tickets-per-email limit, and a retry
// is the same order.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../src/lib/crypto";
import { BookingDb } from "../src/guests/bookings";
import { D1Driver } from "../src/db/driver";
import { clearPartyListCache } from "../src/routes/guests";
import { api, guestParty, harness, scan, seedDoor, signupInit, type Harness, type SignupFields } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

type Answer = { status?: string; error?: string; ticket_id?: string; link?: string; tickets?: { ticket_id: string; name: string; link: string }[] };
async function order(h: Harness, party: string, count: number, names?: unknown[], f: SignupFields = {}, typeId?: string, split = false) {
  const init = await signupInit({ name: "Mona Lead", ...f });
  const body = init.body as Uint8Array;
  const boundary = /boundary=(.*)$/.exec((init.headers as Record<string, string>)["content-type"]!)![1]!;
  const part = (k: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  const extra = new TextEncoder().encode((typeId ? part("type_id", typeId) : "") + (split ? part("individual_tickets", "yes") : "") + part("tickets", String(count)) + (names ? part("names", JSON.stringify(names)) : ""));
  const full = new Uint8Array([...extra, ...body]);
  const r = await h.req(`/api/guest/parties/${party}/signup`, { ...init, body: full, headers: { ...(init.headers as Record<string, string>), "content-length": String(full.length) } });
  return { status: r.status, body: (await r.json()) as Answer };
}
const rows = (party: string) => env.DB.prepare("SELECT id, guest_name, guest_email, order_id, screenshot_key, people FROM tickets WHERE party_id = ? ORDER BY created_at, id")
  .bind(party).all<{ id: string; guest_name: string; guest_email: string; order_id: string | null; screenshot_key: string | null; people: number }>().then((r) => r.results);

describe("orders of separate tickets", () => {
  it("one request makes several tickets, each with its own link; names are optional; the proof stays on the first", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const r = await order(h, party, 3, ["Rami", ""]);
    expect(r.status).toBe(201);
    expect(r.body.tickets).toHaveLength(3);
    expect(r.body.tickets!.map((x) => x.name)).toEqual(["Mona Lead", "Rami", "Mona Lead"]);
    expect(new Set(r.body.tickets!.map((x) => x.link)).size).toBe(3);
    expect(r.body.link).toBe(r.body.tickets![0]!.link);
    const t = await rows(party);
    expect(t).toHaveLength(3);
    const lead = r.body.ticket_id!;
    expect(t.every((x) => x.order_id === lead && x.guest_email === t[0]!.guest_email)).toBe(true);
    expect(t.filter((x) => x.screenshot_key !== null).map((x) => x.id)).toEqual([lead]);

    // Each ticket page works on its own.
    for (const x of r.body.tickets!) {
      const page = await h.req("/api/guest/ticket", { headers: { "x-sahra-ticket": x.link.split("#t=")[1]! } });
      expect(page.status).toBe(200);
      expect(((await page.json()) as { ticket: { id: string } }).ticket.id).toBe(x.ticket_id);
    }
    // The queue lists them with their order; approving and sending all at once gives each its own QR.
    const q = (await (await h.req("/api/tickets?status=pending", { ...api(os), method: "GET", body: undefined })).json()) as { tickets: { id: string; order_id: string }[] };
    expect(q.tickets.filter((x) => x.order_id === lead)).toHaveLength(3);
    const ids = r.body.tickets!.map((x) => x.ticket_id);
    expect(((await (await h.req("/api/tickets/approve", api(os, { ids }))).json()) as { results: Record<string, string> }).results).toEqual(Object.fromEntries(ids.map((i) => [i, "done"])));
    await h.req("/api/tickets/release", api(os, { ids }));
    const versions = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE party_id = ? AND released_at IS NOT NULL").bind(party).first("n");
    expect(versions).toBe(3);

  });

  it("all or none: capacity, the per-email limit and the type's places count the whole order", async () => {
    const h = await harness();
    const { party } = await guestParty(h, { capacity: 4 });
    expect((await order(h, party, 5)).body.error).toBe("full");
    expect(await rows(party)).toHaveLength(0);
    await env.DB.prepare("UPDATE parties SET max_tickets_per_email = 2 WHERE id = ?").bind(party).run();
    expect((await order(h, party, 3, [], { email: "same@example.com" })).body.error).toBe("email_limit");
    expect((await order(h, party, 2, [], { email: "same@example.com" })).status).toBe(201);
    expect((await order(h, party, 1, [], { email: "same@example.com" })).body.error).toBe("email_limit");
    expect(await rows(party)).toHaveLength(2);
    expect((await order(h, party, 11)).status).toBe(400);
    expect((await order(h, party, 2, ["a", "b", "c"])).status).toBe(400);
  });

  it("a retry with the same request token is the same order", async () => {
    const h = await harness();
    const { party } = await guestParty(h);
    const token = "a".repeat(42) + "A";
    const first = await order(h, party, 3, [], { signup: token });
    const again = await order(h, party, 3, [], { signup: token });
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.tickets!.map((x) => x.ticket_id)).toEqual(first.body.tickets!.map((x) => x.ticket_id));
    expect(await rows(party)).toHaveLength(3);
  });
});

async function groupType(h: Harness, os: { token: string; csrf: string }, b: Record<string, unknown> = {}) {
  const r = await h.req("/api/tickets/types", api(os, { op: newId(), name: "Duo", price: 301,
    min_people: 2, max_people: 2, individual_tickets: true, ...b }));
  expect(r.status).toBe(201);
  return ((await r.json()) as { type: { id: string } }).type.id;
}

describe("individual QR tickets at the group price", () => {
  it("creates independent one-person tickets and preserves the exact package total, including rounding", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const typeId = await groupType(h, os);
    const token = "b".repeat(42) + "A";
    const r = await order(h, party, 1, ["Rami"], { people: 2, signup: token }, typeId, true);
    expect(r.status).toBe(201);
    expect(r.body.tickets).toHaveLength(2);
    expect(new Set(r.body.tickets!.map(x => x.link)).size).toBe(2);
    const stored = await env.DB.prepare("SELECT people, price, split_group_size FROM tickets WHERE party_id = ?").bind(party).all<{people:number;price:number;split_group_size:number}>();
    expect(stored.results.every(x => x.people === 1 && x.split_group_size === 2)).toBe(true);
    expect(stored.results.map(x => x.price).sort()).toEqual([150, 151]);
    const retry = await order(h, party, 1, ["Rami"], { people: 2, signup: token }, typeId, true);
    expect(retry.status).toBe(200);
    expect(retry.body.tickets).toEqual(r.body.tickets);
    const ids = r.body.tickets!.map(x => x.ticket_id);
    await h.req("/api/tickets/approve", api(os, { ids }));
    await h.req("/api/tickets/release", api(os, { ids }));
    const qrs = [];
    for (const t of r.body.tickets!) {
      const page = await h.req("/api/guest/ticket", { headers: { "x-sahra-ticket": t.link.split("#t=")[1]! } });
      const body = await page.json() as {ticket:{people:number;qr:string}};
      expect(body.ticket.people).toBe(1);
      expect(body.ticket.qr).toBeTruthy();
      qrs.push(body.ticket.qr);
    }
    expect(new Set(qrs).size).toBe(2);
    expect((await h.req("/api/admission", api(os, { action: "open" }))).status).toBe(200);
    const door = await seedDoor(party, h.clock);
    expect(await scan(h, door, qrs[0]!)).toMatchObject({ verdict: "admit", people: 1 });
    expect(await scan(h, door, qrs[0]!)).toMatchObject({ verdict: "used" });
    expect(await scan(h, door, qrs[1]!)).toMatchObject({ verdict: "admit", people: 1 });
    const stats = await h.req("/api/party/stats", { ...api(os), method: "GET", body: undefined });
    expect(JSON.stringify(await stats.json())).toContain("301");
  });

  it("atomically enforces whole-group capacity, type places, email limit and the ten-person booking cap", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { capacity: 3 });
    const typeId = await groupType(h, os, { quantity: 1 });
    expect((await order(h, party, 1, [], { people: 2 }, typeId, true)).body.error).toBe("type_full");
    await env.DB.prepare("UPDATE ticket_types SET quantity = NULL WHERE id = ?").bind(typeId).run();
    expect((await order(h, party, 2, [], { people: 2 }, typeId, true)).body.error).toBe("full");
    await env.DB.prepare("UPDATE parties SET max_tickets_per_email = 1 WHERE id = ?").bind(party).run();
    expect((await order(h, party, 1, [], { people: 2 }, typeId, true)).body.error).toBe("email_limit");
    expect((await order(h, party, 6, [], { people: 2 }, typeId, true)).status).toBe(400);
    expect(await rows(party)).toHaveLength(0);
  });

  it("rejects an outdated or forged delivery mode, while existing shared group types keep one QR", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const typeId = await groupType(h, os);
    expect((await order(h, party, 1, [], { people: 2 }, typeId)).body.error).toBe("type_unavailable");
    await env.DB.prepare("UPDATE ticket_types SET individual_tickets = 0 WHERE id = ?").bind(typeId).run();
    expect((await order(h, party, 1, [], { people: 2 }, typeId, true)).body.error).toBe("type_unavailable");
    const shared = await order(h, party, 1, [], { people: 2 }, typeId);
    expect(shared.status).toBe(201);
    expect(shared.body.tickets).toHaveLength(1);
    expect((await rows(party))[0]!.people).toBe(2);
  });
});

// The whole booking is resolved server-side, across tabs, pages and email delivery.
describe("verified booking cancellation", () => {
  async function setup(count = 4, approved = true) {
    const h = await harness();
    const { party, os, owner } = await guestParty(h);
    const typeId = await groupType(h, os, { name: count === 2 ? "Duo" : "Squad", price: count * 500, min_people: count, max_people: count });
    const r = await order(h, party, 1, ["Rami", "Laila", "Nour"].slice(0,count-1), { people: count, email: "booking@example.com" }, typeId, true);
    expect(r.status).toBe(201);
    const tickets = r.body.tickets!;
    const ids = tickets.map(x => x.ticket_id);
    if (approved) {
      await h.req("/api/tickets/approve", api(os, { ids }));
      await h.req("/api/tickets/release", api(os, { ids }));
    }
    // Delivery receipt only, no external email or provider request.
    await env.DB.prepare("UPDATE outbox SET status='sent', sent_at=? WHERE party_id=?").bind(h.clock.now(), party).run();
    const door = await seedDoor(party, h.clock);
    expect((await h.req("/api/admission", api(os, {action:"open"}))).status).toBe(200);
    const get = async () => (await (await h.req(`/api/tickets/${ids[1]}/booking`, api(os, undefined, "GET"))).json()) as {
      booking: { id: string; total: number; active: number; cancelled: number; used: number };
      members: {id: string; rev: number; status: string; email_sent_at: number | null; cancelled_by: string | null}[];
    };
    const request = async (expected: {id:string;rev:number}[], op = newId()) => h.req(`/api/tickets/${ids[1]}/cancel-booking`, api(os, {op, expected}));
    return { h, party, os, owner, tickets, ids, door, get, request };
  }

  it.each([2,4])("cancels all %i individual tickets of the booking without changing their paid price",async count=>{
    const {h,party,os,get,request}=await setup(count);
    const before=await get();expect(before.members).toHaveLength(count);
    const response=await request(before.members);expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({booking:{total:count,active:0,cancelled:count}});
    expect(await env.DB.prepare("SELECT SUM(price) AS price FROM tickets WHERE party_id=?").bind(party).first("price")).toBe(count*500);
    const active=await h.req("/api/tickets?status=approved",api(os,undefined,"GET"));
    expect(await active.json()).toMatchObject({tickets:[]});
  });

  it("deleting pending booking requests removes them from Pending without creating or cancelling approved positions",async()=>{
    const {h,os,get,request}=await setup(4,false);const before=await get();
    expect(before.booking).toMatchObject({total:4,pending:4,active:4,deleted:0,cancelled:0});
    const result=await request(before.members);expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({booking:{active:0,pending:0,deleted:4,cancelled:0}});
    const pending=await h.req("/api/tickets?status=pending",api(os,undefined,"GET"));
    expect(await pending.json()).toMatchObject({tickets:[]});
    const guests=await h.req("/api/tickets?status=approved",api(os,undefined,"GET"));
    expect(await guests.json()).toMatchObject({tickets:[]});
    expect((await get()).members.every(x=>x.status==="cancelled")).toBe(true);
  });

  it("cancels every emailed QR across pagination and mixed status, verifies all members, history and active guest counts", async () => {
    const { h, party, os, ids, tickets, door, get, request } = await setup();
    const qr = await Promise.all(tickets.map(async x => (await (await h.req("/api/guest/ticket", {headers:{"x-sahra-ticket":x.link.split("#t=")[1]!}})).json() as {ticket:{qr:string}}).ticket.qr));
    await h.req(`/api/tickets/${ids[0]}/cancel`, api(os, {op:newId()}));
    const preview = await get();
    expect(preview.booking).toMatchObject({total:4,active:3,cancelled:1});
    expect(preview.members.every(x=>x.email_sent_at != null)).toBe(true);
    const page = await (await h.req("/api/tickets?status=approved&limit=1", api(os,undefined,"GET"))).json() as {tickets:{booking:unknown}[];next:string};
    expect(page.tickets).toHaveLength(1);expect(page.next).toBeTruthy();
    expect(page.tickets[0]!.booking).toEqual(preview.booking);
    const result = await request(preview.members);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({status:"verified",booking:{total:4,active:0,cancelled:4}});
    for(let i=0;i<tickets.length;i++) {
      expect(await scan(h,door,qr[i]!)).toMatchObject({verdict:"stop"});
      const view=await h.req("/api/guest/ticket",{headers:{"x-sahra-ticket":tickets[i]!.link.split("#t=")[1]!}});
      expect(await view.json()).toMatchObject({ticket:{status:"cancelled",qr:null}});
    }
    const lookup=await (await h.req("/api/tickets/search?q=booking%40example.com",api(os,undefined,"GET"))).json() as {tickets:{status:string;booking:unknown}[]};
    expect(lookup.tickets).toHaveLength(4);
    expect(lookup.tickets.every(x=>x.status==="cancelled")).toBe(true);
    expect(lookup.tickets[0]!.booking).toEqual((await get()).booking);
    expect((await get()).members.every(x=>!!x.cancelled_by)).toBe(true);
    const stats=await h.req("/api/party/stats",api(os,undefined,"GET"));
    expect(await stats.json()).toMatchObject({approved:0,released:0,pending:0});
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id=? AND status='sent'").bind(party).first("n")).toBe(4);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE party_id=? AND action='cancelled'").bind(party).first("n")).toBe(4);
  });

  it("retries an identical operation without duplicate changes and never re-cancels a restored member using stale confirmation", async () => {
    const {h,os,ids,get,request}=await setup();
    const preview=await get(),op=newId();
    expect((await request(preview.members,op)).status).toBe(200);
    const done=await get();
    expect((await request(preview.members,op)).status).toBe(200);
    expect(await get()).toEqual(done);
    expect((await h.req(`/api/tickets/${ids[0]}/restore`,api(os,{op:newId()}))).status).toBe(200);
    const retry=await request(preview.members,op);
    expect(retry.status).toBe(409);expect(await retry.json()).toMatchObject({error:"booking_changed"});
    expect((await get()).booking).toMatchObject({active:1,cancelled:3});
  });

  it("refuses a booking with a checked-in member without cancelling the remaining guests",async()=>{
    const {h,door,tickets,get,request}=await setup();
    const page=await h.req("/api/guest/ticket",{headers:{"x-sahra-ticket":tickets[0]!.link.split("#t=")[1]!}});
    const qr=(await page.json() as {ticket:{qr:string}}).ticket.qr;
    expect(await scan(h,door,qr)).toMatchObject({verdict:"admit"});
    const preview=await get(),result=await request(preview.members);
    expect(result.status).toBe(409);expect(await result.json()).toMatchObject({error:"booking_used"});
    expect((await get()).booking).toMatchObject({active:3,cancelled:0,used:1});
  });

  it("refuses changed, missing or duplicate confirmation members and enforces party, role and CSRF",async()=>{
    const {h,os,ids,door,get,request}=await setup();
    const preview=await get();
    expect((await request(preview.members.slice(1))).status).toBe(409);
    expect((await request([preview.members[0]!,preview.members[0]!])).status).toBe(400);
    await h.req(`/api/tickets/${ids[0]}/reissue`,api(os,{op:newId()}));
    expect((await request(preview.members)).status).toBe(409);
    expect((await get()).booking.active).toBe(4);
    const other=await guestParty(h);
    expect((await h.req(`/api/tickets/${ids[0]}/booking`,api(other.os,undefined,"GET"))).status).toBe(404);
    expect((await h.req(`/api/tickets/${ids[0]}/cancel-booking`,api(other.os,{op:newId(),expected:preview.members}))).status).toBe(404);
    expect((await h.req(`/api/tickets/${ids[0]}/booking`,api(door,undefined,"GET"))).status).toBe(403);
    expect((await h.req(`/api/tickets/${ids[0]}/cancel-booking`,api({...os,csrf:"invalid"},{op:newId(),expected:preview.members}))).status).toBe(403);
  });

  it("rechecks the entire confirmed snapshot inside the SQL even if a door scan wins the race",async()=>{
    const {h,party,os,owner,ids,door,tickets,get}=await setup();
    const preview=await get();
    const page=await h.req("/api/guest/ticket",{headers:{"x-sahra-ticket":tickets[0]!.link.split("#t=")[1]!}});
    expect(await scan(h,door,(await page.json() as {ticket:{qr:string}}).ticket.qr)).toMatchObject({verdict:"admit"});
    const db=new BookingDb(new D1Driver(env.DB));
    expect(await db.cancel({partyId:party,hash:os.hash},ids[1]!,preview.members,owner.id,h.clock.now(),newId())).toBe(0);
    expect((await get()).booking).toMatchObject({active:3,used:1,cancelled:0});
  });

  it("does not cancel another booking belonging to the same email address",async()=>{
    const {h,party,os,get,request}=await setup();
    const type=await env.DB.prepare("SELECT id FROM ticket_types WHERE party_id=? AND name='Squad'").bind(party).first<string>("id");
    const second=await order(h,party,1,["Other 1","Other 2","Other 3"],{people:4,email:"booking@example.com"},type!,true);
    expect(second.status).toBe(201);
    const otherIds=second.body.tickets!.map(x=>x.ticket_id);
    await h.req("/api/tickets/approve",api(os,{ids:otherIds}));
    const preview=await get();
    expect((await request(preview.members)).status).toBe(200);
    const untouched=await env.DB.prepare("SELECT status FROM tickets WHERE order_id=?").bind(second.body.ticket_id).all<{status:string}>();
    expect(untouched.results).toHaveLength(4);expect(untouched.results.every(x=>x.status==="approved")).toBe(true);
  });

  it("filters every page on the server and preserves complete booking summaries",async()=>{
    const {h,os,ids,tickets,door,get}=await setup();
    await h.req(`/api/tickets/${ids[0]}/cancel`,api(os,{op:newId()}));
    const matches: string[]=[];let after="";
    do {
      const r=await h.req("/api/tickets?status=all&booking=partial&q=booking%40example.com&limit=1"+(after?"&after="+after:""),api(os,undefined,"GET"));
      expect(r.status).toBe(200);
      const p=await r.json() as {tickets:{id:string;booking:{total:number;active:number;cancelled:number}}[];next:string|null};
      for(const x of p.tickets){matches.push(x.id);expect(x.booking).toMatchObject({total:4,active:3,cancelled:1});}
      after=p.next||"";
    } while(after);
    expect(new Set(matches).size).toBe(4);expect(matches).toHaveLength(4);
    const list=async(query:string)=>(await (await h.req("/api/tickets?status=all&"+query,api(os,undefined,"GET"))).json()) as {tickets:{id:string}[]};
    expect((await list("delivery=emailed&booking=group")).tickets).toHaveLength(4);
    expect((await list("delivery=unreleased")).tickets).toHaveLength(0);
    expect((await list("booking=single")).tickets).toHaveLength(0);
    expect((await list("q=not-a-guest")).tickets).toHaveLength(0);
    const page=await h.req("/api/guest/ticket",{headers:{"x-sahra-ticket":tickets[1]!.link.split("#t=")[1]!}});
    expect(await scan(h,door,(await page.json() as {ticket:{qr:string}}).ticket.qr)).toMatchObject({verdict:"admit"});
    expect((await list("entry=used")).tickets.map(x=>x.id)).toEqual([ids[1]]);
    expect((await list("entry=unused")).tickets).toHaveLength(3);
    expect((await get()).booking).toMatchObject({used:1,active:2,cancelled:1});
    for(const q of ["type=invalid","delivery=bad","entry=bad","booking=bad","q="+"a".repeat(81)])
      expect((await h.req("/api/tickets?"+q,api(os,undefined,"GET"))).status).toBe(400);
  });

  it("exposes a recoverable single-ticket confirmation without expanding it to the booking",async()=>{
    const {h,os,ids,get}=await setup();const op=newId();
    h.ledger.mode="fail";
    expect((await h.req(`/api/tickets/${ids[0]}/cancel`,api(os,{op}))).status).toBe(503);
    const preview=await get();
    expect(preview.booking).toMatchObject({active:3,cancelled:1,unconfirmed:1});
    expect(preview.members.find(x=>x.id===ids[0])).toMatchObject({status:"cancelled",last_action:"cancelled",last_op:op});
    h.ledger.mode="ok";
    expect((await h.req(`/api/tickets/${ids[0]}/cancel`,api(os,{op}))).status).toBe(200);
    expect((await get()).booking).toMatchObject({active:3,cancelled:1,unconfirmed:0});
  });

  it("fails closed when intent or final ledger write fails, then completes the same operation",async()=>{
    const {h,get,request}=await setup();
    const preview=await get(),op=newId();
    h.ledger.intentMode="fail";
    expect((await request(preview.members,op)).status).toBe(503);
    expect((await get()).booking).toMatchObject({active:4,cancelled:0});
    h.ledger.intentMode="ok";h.ledger.mode="fail";
    expect((await request(preview.members,op)).status).toBe(503);
    expect((await get()).booking).toMatchObject({active:0,cancelled:4,unconfirmed:4});
    h.ledger.mode="ok";
    expect((await request(preview.members,op)).status).toBe(200);
  });
});
