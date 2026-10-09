// Cash guests (brainstorm ideas 9 and 17, migrations/0027): one by one or from a
// CSV file, approved at once and marked "paid in cash", with the same capacity,
// type, people and tickets-per-email rules as a guest request (inside the
// INSERT); "Send QRs now" emails each guest, "Add only" leaves them approved and
// not sent; a retry of the same import creates nobody twice; the dashboard shows
// the cash total and the export a payment column.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearPartyListCache } from "../src/routes/guests";
import { api, guestParty, harness, type Harness } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

type Result = { row: number; status: string; ticket_id?: string };
async function importRows(h: Harness, os: { token: string; csrf: string }, op: string, start: number, rows: unknown[], release: boolean) {
  const r = await h.req("/api/tickets/import", api(os, { op, start, release, rows }));
  return { status: r.status, results: ((await r.json()) as { results: Result[] }).results };
}

describe("cash guests", () => {
  it("imports approved cash tickets with the normal rules; a retry is the same; send now or add only", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { capacity: 6 });
    await env.DB.prepare("UPDATE parties SET max_tickets_per_email = 1 WHERE id = ?").bind(party).run();
    const t = await h.req("/api/tickets/types", api(os, { op: crypto.randomUUID(), name: "Entry", price: 400 }));
    const typeId = ((await t.json()) as { type: { id: string } }).type.id;
    const op = crypto.randomUUID();
    const rows = [
      { name: "Cash One", email: "one@example.com", people: 2, type_id: typeId },
      { name: "Cash Two", email: "two@example.com", people: 1, type_id: typeId },
      { name: "Twice", email: "one@example.com", people: 1, type_id: typeId },   // over the tickets-per-email limit
      { name: "", email: "bad" },                                                 // not a guest
      { name: "Too Many", email: "big@example.com", people: 4, type_id: typeId },  // over capacity (2 + 1 + 4 > 6)
    ];
    const a = await importRows(h, os, op, 0, rows, true);
    expect(a.status).toBe(200);
    expect(a.results.map((r) => r.status)).toEqual(["created", "created", "email_limit", "invalid", "full"]);
    // A retry of the same chunk creates nobody twice.
    const again = await importRows(h, os, op, 0, rows, true);
    expect(again.results.map((r) => r.status)).toEqual(["already", "already", "email_limit", "invalid", "full"]);
    const made = (await env.DB.prepare("SELECT guest_name, status, payment, price, released_at FROM tickets WHERE party_id = ? ORDER BY guest_name").bind(party)
      .all<{ guest_name: string; status: string; payment: string; price: number; released_at: number | null }>()).results;
    expect(made).toEqual([
      expect.objectContaining({ guest_name: "Cash One", status: "approved", payment: "cash", price: 400 }),
      expect.objectContaining({ guest_name: "Cash Two", status: "approved", payment: "cash", price: 400 }),
    ]);
    expect(made.every((m) => m.released_at !== null)).toBe(true);
    // Sent now: one QR email each, sent without approval (like any ticket email).
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM outbox WHERE party_id = ? AND kind = 'ticket_released'").bind(party).first("n")).toBe(2);

    // Add only: approved, not sent, no email.
    const b = await importRows(h, os, crypto.randomUUID(), 0, [{ name: "Later Guest", email: "later@example.com", people: 1, type_id: typeId }], false);
    expect(b.results[0]!.status).toBe("created");
    expect(await env.DB.prepare("SELECT released_at FROM tickets WHERE id = ?").bind(b.results[0]!.ticket_id).first("released_at")).toBeNull();

    // The dashboard's cash total and the export's payment column.
    const stats = (await (await h.req("/api/party/stats", api(os, undefined, "GET"))).json()) as { money_cash: number; money_expected: number };
    expect(stats.money_cash).toBe(400 * 2 + 400 + 400);
    const exp = (await (await h.req("/api/tickets/export?limit=50", api(os, undefined, "GET"))).json()) as { tickets: { payment: string | null }[] };
    expect(exp.tickets.filter((x) => x.payment === "cash")).toHaveLength(3);

    // At most 5 rows per request; a single cash guest through /issue keeps the type price.
    expect((await importRows(h, os, crypto.randomUUID(), 0, Array.from({ length: 6 }, (_, i) => ({ name: `G${i}` })), false)).status).toBe(400);
    const one = await h.req("/api/tickets/issue", api(os, { op: crypto.randomUUID(), name: "Door Cash", people: 1, type_id: typeId, cash: true, release: false }));
    expect(one.status).toBe(201);
    const id = ((await one.json()) as { ticket_id: string }).ticket_id;
    expect(await env.DB.prepare("SELECT payment, price FROM tickets WHERE id = ?").bind(id).first()).toEqual({ payment: "cash", price: 400 });
  });
});
