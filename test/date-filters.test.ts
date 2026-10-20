import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { parseDateRange } from "../src/lib/date-range";
import { api, harness, seedDoor, seedOwner, seedParty, seedSession } from "./helpers";

describe("creation-date filters", () => {
  it("validates inclusive/exclusive bounds without accepting malformed, reversed or unsafe numbers", () => {
    expect(parseDateRange(undefined, undefined)).toEqual({ createdFrom: undefined, createdBefore: undefined });
    expect(parseDateRange("0", "1")).toEqual({ createdFrom: 0, createdBefore: 1 });
    for (const [from, before] of [["", undefined], ["-1", undefined], ["1.5", undefined], ["1e3", undefined], ["NaN", undefined], ["8640000000000001", undefined], ["9007199254740992", undefined], [undefined, "bad"], ["10", "10"], ["11", "10"], ["0 OR 1=1", undefined]])
      expect(parseDateRange(from, before)).toBe(false);
  });

  it("filters tickets before pagination, retains status/search constraints and excludes other parties", async () => {
    const h = await harness(), party = await seedParty(), other = await seedParty();
    const owner = await seedOwner(party), os = await seedSession(party, owner.id, "owner", h.clock);
    const base = h.clock.now() - 100000;
    const statements = Array.from({ length: 70 }, (_, i) => env.DB.prepare("INSERT INTO tickets(id,party_id,status,guest_name,created_at,rev,logged_rev) VALUES(?,?,'pending',?,?,1,1)")
      .bind(String(i).padStart(16, "0"), party, `Range Guest ${i}`, base + i));
    statements.push(env.DB.prepare("INSERT INTO tickets(id,party_id,status,guest_name,created_at,rev,logged_rev) VALUES('9999999999999999',?,'approved','Other party',?,1,1)").bind(other, base + 20));
    await env.DB.batch(statements);
    const range = `created_from=${base + 10}&created_before=${base + 65}`;
    type Page = { tickets: { id: string; created_at: number }[]; next: string | null };
    const get = async (q: string): Promise<Page> => { const r = await h.req(`/api/tickets?${q}`, api(os, undefined, "GET")); expect(r.status).toBe(200); return r.json(); };
    const seen: Page["tickets"] = []; let after = "";
    do { const p = await get(`status=all&limit=20&${range}${after ? `&after=${after}` : ""}`); seen.push(...p.tickets); after = p.next || ""; } while (after);
    expect(seen.map(x => x.created_at)).toEqual(Array.from({ length: 55 }, (_, i) => base + 10 + i));
    expect((await get(`status=approved&${range}`)).tickets).toEqual([]);
    expect((await get(`status=pending&q=Range%20Guest%2020&${range}`)).tickets.map(x => x.created_at)).toEqual([base + 20]);
    expect((await get(`created_from=${base + 69}`)).tickets.map(x => x.created_at)).toEqual([base + 69]);
    expect((await get(`created_before=${base + 1}`)).tickets.map(x => x.created_at)).toEqual([base]);
    for (const q of ["created_from=bad", "created_before=-1", "created_from=2&created_before=1"])
      expect((await h.req(`/api/tickets?${q}`, api(os, undefined, "GET"))).status).toBe(400);
    const door = await seedDoor(party, h.clock);
    expect((await h.req(`/api/tickets?${range}`, api(door, undefined, "GET"))).status).toBe(403);
  });

  it("filters emails before the newest-first cursor and keeps bulk actions independent of the date filter", async () => {
    const h = await harness(), party = await seedParty(), other = await seedParty();
    const owner = await seedOwner(party), os = await seedSession(party, owner.id, "owner", h.clock);
    const base = h.clock.now() - 100000;
    await env.DB.batch(Array.from({length:71}, (_,i) => env.DB.prepare("INSERT INTO outbox(id,party_id,kind,to_email,subject,body_text,status,created_at,next_attempt_at) VALUES(?,?,'party_notice','fixture@example.com','Fixture','Fixture','awaiting_approval',?,?)")
      .bind((i % 2 ? "announce:" : "") + `00000000-0000-4000-8000-${String(i).padStart(12, "0")}` + (i % 2 ? `:${String(i).padStart(16,"0")}` : ""), i === 70 ? other : party, base + i, base + i)));
    const range = `created_from=${base + 10}&created_before=${base + 65}`;
    type Page = { rows: { created_at: number }[]; next: string | null };
    const get = async (q: string): Promise<Page> => { const r = await h.req(`/api/outbox?${q}`, api(os, undefined, "GET")); expect(r.status).toBe(200); return r.json(); };
    const p1 = await get(`status=awaiting_approval&${range}`);
    expect(p1.rows).toHaveLength(50); expect(p1.next).toBeTruthy();
    const p2 = await get(`status=awaiting_approval&${range}&before=${encodeURIComponent(p1.next!)}`);
    expect(p2.rows).toHaveLength(5); expect(p2.next).toBeNull();
    expect([...p1.rows,...p2.rows].map(x=>x.created_at)).toEqual(Array.from({length:55},(_,i)=>base + 64 - i));
    expect((await get(`status=sent&${range}`)).rows).toEqual([]);
    expect((await get(`created_from=${base + 69}`)).rows.map(x=>x.created_at)).toEqual([base + 69]);
    expect((await get(`created_before=${base + 1}`)).rows.map(x=>x.created_at)).toEqual([base]);
    for(const q of ["created_from=bad", "created_before=-1", "created_from=2&created_before=1"])
      expect((await h.req(`/api/outbox?${q}`, api(os, undefined, "GET"))).status).toBe(400);
    expect(await (await h.req(`/api/outbox/approve?${range}`,api(os,{all_awaiting:true}))).json()).toEqual({approved:70});
    expect(await env.DB.prepare("SELECT status FROM outbox WHERE party_id = ?").bind(other).first("status")).toBe("awaiting_approval");
  });
});
