// "Find guest" and manual admit at the door (brainstorm idea 8): a guest whose QR
// will not scan is found by name and admitted through the SAME single-use
// redemption as a scan. A ticket can never get in twice (a manual admit after a
// scan, a scan after a manual admit, two phones at once); paused admission and an
// unconfirmed ledger write are never green; each manual admit is in the audit log
// with the staff member, and the organiser can list them.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { newId } from "../src/lib/crypto";
import { api, harness, openParty, scan, seedDoor, testTickets, type Harness } from "./helpers";

type V = { verdict: string; manual?: boolean; name?: string; reason?: string };
async function admit(h: Harness, sess: { token: string; csrf: string }, ticketId: string, scanId = newId()): Promise<V> {
  const r = await h.req("/api/scan/manual", api(sess, { scan_id: scanId, ticket_id: ticketId }));
  return r.status === 200 ? ((await r.json()) as V) : { verdict: `http_${r.status}` };
}
async function find(h: Harness, sess: { token: string; csrf: string }, q: string) {
  const r = await h.req(`/api/scan/find?q=${encodeURIComponent(q)}`, api(sess, undefined, "GET"));
  return { status: r.status, body: (await r.json()) as { tickets: { id: string; name: string; email: string | null; state: string; used_by: string | null }[] } };
}
async function setup() {
  const h = await harness();
  const p = await openParty(h);
  const door = await seedDoor(p.party, h.clock);
  const [t] = await testTickets(h, p.os, 1, 2);
  await env.DB.prepare("UPDATE tickets SET guest_name = 'Mona Salem', guest_email = 'mona@example.com' WHERE id = ?").bind(t!.id).run();
  return { h, ...p, door, t: t! };
}

describe("find guest and manual admit", () => {
  it("door staff find a guest by name, admit once; a later scan of the same ticket is not green", async () => {
    const { h, os, door, t, party } = await setup();
    const f = await find(h, door, "mona");
    expect(f.status).toBe(200);
    expect(f.body.tickets).toEqual([expect.objectContaining({ id: t.id, name: "Mona Salem", email: "m***@example.com", state: "ready" })]);
    const v = await admit(h, door, t.id);
    expect(v).toMatchObject({ verdict: "admit", manual: true, name: "Mona Salem" });
    // The same ticket again, by hand or by QR: never green.
    expect((await admit(h, door, t.id)).verdict).toBe("used");
    expect((await scan(h, door, t.qr)).verdict).toBe("used");
    expect((await find(h, door, "Mona")).body.tickets[0]).toMatchObject({ state: "used" });
    // Recorded as manual, with who did it; the organiser's list shows it.
    const a = await env.DB.prepare("SELECT actor_staff_id, detail FROM audit WHERE party_id = ? AND action = 'admitted_manually' AND entity_id = ?").bind(party, t.id).all();
    expect(a.results).toEqual([expect.objectContaining({ actor_staff_id: door.id })]);
    const list = (await (await h.req("/api/scan/manual", api(os, undefined, "GET"))).json()) as { admits: { ticket_id: string; guest_name: string; staff_name: string }[] };
    expect(list.admits).toEqual([expect.objectContaining({ ticket_id: t.id, guest_name: "Mona Salem" })]);
    expect((await h.req("/api/scan/manual", api(door, undefined, "GET"))).status).toBe(403);
  });

  it("a ticket already scanned cannot be admitted by hand; two phones at once admit it once", async () => {
    const { h, party, door, t } = await setup();
    expect((await scan(h, door, t.qr)).verdict).toBe("admit");
    expect((await admit(h, door, t.id)).verdict).toBe("used");

    const [u] = await testTickets(h, (await openPartySession(h, party)), 1, 1);
    const other = await seedDoor(party, h.clock);
    const both = await Promise.all([admit(h, door, u!.id), admit(h, other, u!.id), scan(h, other, u!.qr)]);
    expect(both.filter((x) => x.verdict === "admit")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM scans WHERE ticket_id = ? AND outcome = 'admitted'").bind(u!.id).first("n")).toBe(1);
  });

  it("paused admission, an unconfirmed ledger write, a pending or unknown ticket: never green", async () => {
    const { h, os, door, t, party } = await setup();
    await h.req("/api/admission", api(os, { action: "pause" }));
    expect((await admit(h, door, t.id)).verdict).toBe("paused");
    await h.req("/api/admission", api(os, { action: "open" }));

    // The ledger write fails: amber "recording"; the retry with the same scan id finishes it, once.
    const scanId = newId();
    h.ledger.admissionMode = "fail";
    expect((await admit(h, door, t.id, scanId)).verdict).toBe("recording");
    h.ledger.admissionMode = "ok";
    expect((await admit(h, door, t.id, scanId)).verdict).toBe("admit");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE action = 'admitted_manually' AND entity_id = ?").bind(t.id).first("n")).toBe(1);

    // Not approved yet, or not this party's: refused.
    await env.DB.prepare("INSERT INTO tickets (id, party_id, status, people, guest_name, created_at) VALUES ('PEND000000000000', ?, 'pending', 1, 'Waiting Guest', 0)").bind(party).run();
    expect((await find(h, door, "Waiting")).body.tickets[0]).toMatchObject({ state: "pending" });
    expect((await admit(h, door, "PEND000000000000")).verdict).toBe("stop");
    expect((await admit(h, door, "ZZZZZZZZZZZZZZZZ")).verdict).toBe("stop");
    expect((await admit(h, door, "not-an-id")).verdict).toBe("http_400");
  });

  it("another party's door cannot find or admit this party's guests", async () => {
    const { h, t } = await setup();
    const elsewhere = await openParty(h);
    const theirDoor = await seedDoor(elsewhere.party, h.clock);
    expect((await find(h, theirDoor, "Mona")).body.tickets).toEqual([]);
    expect((await admit(h, theirDoor, t.id)).verdict).toBe("stop");
    expect(await env.DB.prepare("SELECT used_at FROM tickets WHERE id = ?").bind(t.id).first("used_at")).toBeNull();
  });
});

async function openPartySession(h: Harness, party: string) {
  const { seedOwner, seedSession } = await import("./helpers");
  const o = await seedOwner(party);
  return seedSession(party, o.id, "owner", h.clock);
}
