// Several separate tickets in one request (migrations/0022_ticket_orders.sql): each
// ticket has its own link and QR code, all are created or none, the whole order is
// counted against capacity, type places and the tickets-per-email limit, and a retry
// is the same order.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPartyListCache } from "../src/routes/guests";
import { api, guestParty, harness, signupInit, type Harness, type SignupFields } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

type Answer = { status?: string; error?: string; ticket_id?: string; link?: string; tickets?: { ticket_id: string; name: string; link: string }[] };
async function order(h: Harness, party: string, count: number, names?: unknown[], f: SignupFields = {}) {
  const init = await signupInit({ name: "Mona Lead", ...f });
  const body = init.body as Uint8Array;
  const boundary = /boundary=(.*)$/.exec((init.headers as Record<string, string>)["content-type"]!)![1]!;
  const part = (k: string, v: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  const extra = new TextEncoder().encode(part("tickets", String(count)) + (names ? part("names", JSON.stringify(names)) : ""));
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
