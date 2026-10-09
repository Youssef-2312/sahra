// Outbox endpoints: owner/admin only, list paged, approve and cancel (single,
// bulk, all awaiting), never another party's rows, races.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Driver } from "../src/db/driver";
import { sql } from "../src/db/sql";
import { newId } from "../src/lib/crypto";
import { outboxInsert } from "../src/outbox";
import { api, harness, seedDoor, seedOwner, seedParty, seedSession, type Harness } from "./helpers";

async function setup() {
  const h = await harness();
  const party = await seedParty();
  const owner = await seedOwner(party);
  const os = await seedSession(party, owner.id, "owner", h.clock);
  return { h, party, owner, os };
}

async function add(h: Harness, party: string, n: number, needsApproval: boolean) {
  const ids: string[] = [];
  const qs = [];
  for (let i = 0; i < n; i++) {
    const id = newId();
    ids.push(id);
    qs.push(outboxInsert({
      id, partyId: party, kind: needsApproval ? "party_notice" : "ticket_link", toEmail: `g${i}@example.com`,
      subject: "Notice", bodyText: "The party starts at 9.", now: h.clock.now() + i, createdBy: null, needsApproval,
    }, sql`1`));
  }
  await new D1Driver(env.DB).batch(qs);
  return ids;
}

const status = async (id: string) => (await env.DB.prepare("SELECT status FROM outbox WHERE id = ?").bind(id).first("status")) as string;

describe("outbox endpoints", () => {
  it("lists the party's outbox newest first, paged, filtered by status", async () => {
    const { h, party, os } = await setup();
    const other = await seedParty();
    await add(h, other, 3, false);
    const ids = await add(h, party, 60, false);
    const wait = await add(h, party, 2, true);
    const r1 = await h.req("/api/outbox", { ...api(os), method: "GET", body: undefined });
    expect(r1.status).toBe(200);
    const p1 = (await r1.json()) as { rows: { id: string; status: string; body_text: string }[]; next: string };
    expect(p1.rows.length).toBe(50);
    expect(p1.rows[0]!.body_text).toBe("The party starts at 9.");
    const p2 = (await (await h.req(`/api/outbox?before=${encodeURIComponent(p1.next)}`, { ...api(os), method: "GET", body: undefined })).json()) as typeof p1;
    expect(p2.rows.length).toBe(12);
    expect(p2.next).toBeNull();
    const all = [...p1.rows, ...p2.rows].map((r) => r.id);
    expect(new Set(all)).toEqual(new Set([...ids, ...wait]));
    const f = (await (await h.req("/api/outbox?status=awaiting_approval", { ...api(os), method: "GET", body: undefined })).json()) as typeof p1;
    expect(f.rows.map((r) => r.id).sort()).toEqual([...wait].sort());
    expect((await h.req("/api/outbox?status=bogus", { ...api(os), method: "GET", body: undefined })).status).toBe(400);
    expect((await h.req("/api/outbox?before=x", { ...api(os), method: "GET", body: undefined })).status).toBe(400);
  });

  it("approves single and bulk rows; approved rows are queued and due; repeats change nothing", async () => {
    const { h, party, owner, os } = await setup();
    const [a, b, c, d] = await add(h, party, 4, true);
    const r = await h.req(`/api/outbox/${a}/approve`, api(os));
    expect(await r.json()).toEqual({ approved: 1 });
    const row = await env.DB.prepare("SELECT status, approved_by, approved_at, next_attempt_at FROM outbox WHERE id = ?").bind(a).first();
    expect(row).toEqual({ status: "queued", approved_by: owner.id, approved_at: h.clock.now(), next_attempt_at: h.clock.now() });
    expect(await (await h.req("/api/outbox/approve", api(os, { ids: [a, b, c] }))).json()).toEqual({ approved: 2 });
    expect(await (await h.req("/api/outbox/approve", api(os, { all_awaiting: true }))).json()).toEqual({ approved: 1 });
    expect(await status(d!)).toBe("queued");
    expect(await (await h.req("/api/outbox/approve", api(os, { all_awaiting: true }))).json()).toEqual({ approved: 0 });
    expect((await h.req("/api/outbox/approve", api(os, { ids: [] }))).status).toBe(400);
    expect((await h.req("/api/outbox/approve", api(os, { ids: ["x"] }))).status).toBe(400);
    expect((await h.req("/api/outbox/approve", api(os, { ids: Array.from({ length: 501 }, newId) }))).status).toBe(400);
  });

  it("guest messages and change notices can be approved or cancelled one by one (their ids are not UUIDs)", async () => {
    const { h, party, os } = await setup();
    const ids = [`announce:${newId()}:GEW0SJ0R1990BWYY`, `notice:${newId()}:7Q2M9XK4HZ01ABCD`, `announce:${newId()}:GEW0SJ0R1990BWYZ`];
    await new D1Driver(env.DB).batch(ids.map((id, i) => outboxInsert({
      id, partyId: party, kind: "party_notice", toEmail: `g${i}@example.com`, subject: "Notice", bodyText: "Text.", now: h.clock.now(), createdBy: null, needsApproval: true,
    }, sql`1`)));
    expect(await (await h.req(`/api/outbox/${encodeURIComponent(ids[0]!)}/approve`, api(os))).json()).toEqual({ approved: 1 });
    expect(await (await h.req("/api/outbox/cancel", api(os, { ids: [ids[1]] }))).json()).toEqual({ cancelled: 1 });
    expect([await status(ids[0]!), await status(ids[1]!), await status(ids[2]!)]).toEqual(["queued", "cancelled", "awaiting_approval"]);
    for (const bad of ["announce:x:GEW0SJ0R1990BWYY", `other:${newId()}:GEW0SJ0R1990BWYY`, `announce:${newId()}:abc`, `announce:${newId()}:GEW0SJ0R1990BWYI`, `announce:${newId()}:GEW0SJ0R1990BWYY:x`])
      expect((await h.req("/api/outbox/approve", api(os, { ids: [bad] }))).status).toBe(400);
  });

  it("an admin can approve and cancel; door staff see and change nothing", async () => {
    const { h, party } = await setup();
    const admin = await seedOwner(party, undefined, "admin");
    const as = await seedSession(party, admin.id, "admin", h.clock);
    const door = await seedDoor(party, h.clock);
    const [a, b] = await add(h, party, 2, true);
    expect((await h.req("/api/outbox", { ...api(door), method: "GET", body: undefined })).status).toBe(403);
    expect((await h.req(`/api/outbox/${a}/approve`, api(door))).status).toBe(403);
    expect((await h.req("/api/outbox/cancel", api(door, { all_awaiting: true }))).status).toBe(403);
    expect(await status(a!)).toBe("awaiting_approval");
    expect(await (await h.req(`/api/outbox/${a}/approve`, api(as))).json()).toEqual({ approved: 1 });
    expect(await (await h.req(`/api/outbox/${b}/cancel`, api(as))).json()).toEqual({ cancelled: 1 });
    expect(await env.DB.prepare("SELECT status, cancelled_by FROM outbox WHERE id = ?").bind(b).first()).toEqual({ status: "cancelled", cancelled_by: admin.id });
  });

  it("never touches another party's rows", async () => {
    const { h, os } = await setup();
    const other = await seedParty();
    const [x] = await add(h, other, 1, true);
    expect(await (await h.req(`/api/outbox/${x}/approve`, api(os))).json()).toEqual({ approved: 0 });
    expect(await (await h.req("/api/outbox/cancel", api(os, { ids: [x] }))).json()).toEqual({ cancelled: 0 });
    expect(await (await h.req("/api/outbox/approve", api(os, { all_awaiting: true }))).json()).toEqual({ approved: 0 });
    expect(await status(x!)).toBe("awaiting_approval");
  });

  it("cancels awaiting and queued rows, never rows being sent or already sent", async () => {
    const { h, party, os } = await setup();
    const [w] = await add(h, party, 1, true);
    const [q, s, done] = await add(h, party, 3, false);
    await env.DB.batch([
      env.DB.prepare("UPDATE outbox SET status = 'sending', claim_op = 'run' WHERE id = ?").bind(s),
      env.DB.prepare("UPDATE outbox SET status = 'sent' WHERE id = ?").bind(done),
    ]);
    expect(await (await h.req("/api/outbox/cancel", api(os, { ids: [w, q, s, done] }))).json()).toEqual({ cancelled: 2 });
    expect([await status(w!), await status(q!), await status(s!), await status(done!)]).toEqual(["cancelled", "cancelled", "sending", "sent"]);
    // A cancelled row cannot be approved back.
    expect(await (await h.req(`/api/outbox/${w}/approve`, api(os))).json()).toEqual({ approved: 0 });
  });

  it("two approvals at once approve each row once; approve racing cancel leaves one outcome", async () => {
    const { h, party, os } = await setup();
    const ids = await add(h, party, 20, true);
    const [r1, r2] = await Promise.all([
      h.req("/api/outbox/approve", api(os, { all_awaiting: true })),
      h.req("/api/outbox/approve", api(os, { ids })),
    ]);
    const n1 = ((await r1.json()) as { approved: number }).approved, n2 = ((await r2.json()) as { approved: number }).approved;
    expect(n1 + n2).toBe(20);
    const [x] = await add(h, party, 1, true);
    const [ra, rc] = await Promise.all([h.req(`/api/outbox/${x}/approve`, api(os)), h.req(`/api/outbox/${x}/cancel`, api(os))]);
    const a = ((await ra.json()) as { approved: number }).approved, c = ((await rc.json()) as { cancelled: number }).cancelled;
    // Both orders are fine: approved then cancelled (queued rows can be cancelled), or cancelled first.
    expect(a + c).toBeGreaterThanOrEqual(1);
    expect(["cancelled", "queued"]).toContain(await status(x!));
    if (c === 1) expect(await status(x!)).toBe("cancelled");
  });

  it("rows written per approved / cancelled row (measured)", async () => {
    const { h, party, owner, os } = await setup();
    const ids = await add(h, party, 10, true);
    const { OutboxAdmin } = await import("../src/email/admin");
    const d = new D1Driver(env.DB);
    expect(await new OutboxAdmin(d).approve({ hash: os.hash, partyId: party }, owner.id, { ids: ids.slice(0, 5) }, h.clock.now())).toBe(5);
    const approved = d.usage.rows_written;
    expect(await new OutboxAdmin(d).cancel({ hash: os.hash, partyId: party }, owner.id, { allAwaiting: true }, h.clock.now())).toBe(5);
    // Measured: 2 per row (the row + its outbox_due entry), both ways.
    expect(approved).toBe(10);
    expect(d.usage.rows_written - approved).toBe(10);
  });

  it("an expired or revoked session changes nothing", async () => {
    const { h, party, os } = await setup();
    const [a] = await add(h, party, 1, true);
    await env.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id_hash = ?").bind(os.hash).run();
    expect((await h.req(`/api/outbox/${a}/approve`, api(os))).status).toBe(401);
    expect(await status(a!)).toBe("awaiting_approval");
  });

  it("the sessionValid check is inside the statement (a session revoked between check and update changes nothing)", async () => {
    const { h, party, owner, os } = await setup();
    const [a] = await add(h, party, 1, true);
    const { OutboxAdmin } = await import("../src/email/admin");
    await env.DB.prepare("UPDATE sessions SET revoked_at = 1 WHERE id_hash = ?").bind(os.hash).run();
    const n = await new OutboxAdmin(new D1Driver(env.DB)).approve({ hash: os.hash, partyId: party }, owner.id, { allAwaiting: true }, h.clock.now());
    expect(n).toBe(0);
    expect(await status(a!)).toBe("awaiting_approval");
  });
});
