// Home page (Phase 5): the public party list and the status of remembered tickets.
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { clearPartyListCache } from "../src/routes/guests";
import { api, guestParty, harness, ORIGIN, signup } from "./helpers";

beforeEach(() => clearPartyListCache());

async function list(h: Awaited<ReturnType<typeof harness>>) {
  const r = await h.req("/api/guest/parties");
  expect(r.headers.get("cache-control")).toBe("public, max-age=60");
  return ((await r.json()) as { parties: { id: string; name: string; state: string; from_price: number | null; places_left: number }[] }).parties;
}

describe("home page party list", () => {
  it("lists dated parties that are not switched off or over, soonest first, without the place", async () => {
    const h = await harness();
    const now = h.clock.now();
    const a = await guestParty(h, { capacity: 10 });
    const b = await guestParty(h);
    const off = await guestParty(h);
    const over = await guestParty(h);
    const undated = await guestParty(h);
    const set = (p: string, sql: string, ...v: unknown[]) => env.DB.prepare(`UPDATE parties SET ${sql} WHERE id = ?`).bind(...v, p).run();
    await set(a.party, "starts_at = ?, address = 'Secret street', address_mode = 'with_ticket'", now + 2 * 86_400_000);
    await set(b.party, "starts_at = ?", now + 86_400_000);
    await set(off.party, "starts_at = ?, disabled_at = ?", now + 86_400_000, now);
    await set(over.party, "starts_at = ?, ends_at = ?", now - 86_400_000, now - 3_600_000);
    await env.DB.prepare("INSERT INTO ticket_types (id, party_id, name, price, sort, created_at, logged_rev) VALUES ('HOMETYPEAAAAAAAA', ?, 'Early', 250, 0, 1, 1), ('HOMETYPEBBBBBBBB', ?, 'Regular', 400, 1, 1, 1)")
      .bind(a.party, a.party).run();
    // A pending request for 2 (the party has ticket types, so it is added directly here).
    await env.DB.prepare("INSERT INTO tickets (id, party_id, status, people, type_id, created_at, logged_rev) VALUES ('HOMETICKETAAAAAA', ?, 'pending', 2, 'HOMETYPEAAAAAAAA', 1, 1)")
      .bind(a.party).run();
    const mine = (await list(h)).filter((p) => [a.party, b.party, off.party, over.party, undated.party].includes(p.id));
    expect(mine.map((p) => p.id)).toEqual([b.party, a.party]);
    expect(mine[1]).toMatchObject({ state: "open", from_price: 250, places_left: 8 });
    expect(JSON.stringify(mine)).not.toContain("Secret street");
    // Full and registration rules show as the card's state.
    await set(b.party, "capacity = 0");
    clearPartyListCache();
    expect((await list(h)).find((p) => p.id === b.party)!.state).toBe("full");
  });
});

describe("remembered tickets", () => {
  it("answers each link's status in one call; a bad or replaced link is invalid", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const s = await signup(h, party);
    const token = s.body.link!.replace(/^.*#t=/, "");
    const status = async (links: string[]) => ((await (await h.req("/api/guest/tickets/status", {
      method: "POST", headers: { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ links }),
    })).json()) as { tickets: { status: string; party_name?: string }[] }).tickets;
    expect((await status([token, "T1.NOPE.1AAAAAAAAAAAAAAAA.1.AAAAAAAAAAAAAAAAAAAAAAAAAA", "junk"])).map((x) => x.status)).toEqual(["pending", "invalid", "invalid"]);
    await h.req("/api/tickets/approve", api(os, { ids: [s.body.ticket_id] }));
    await h.req("/api/tickets/release", api(os, { ids: [s.body.ticket_id] }));
    expect((await status([token]))[0]).toMatchObject({ status: "released", party_name: `Party ${party}` });
    // A name transfer replaces the link: the old one is invalid.
    await h.req(`/api/tickets/${s.body.ticket_id}/transfer`, api(os, { op: crypto.randomUUID(), name: "Someone Else" }));
    expect((await status([token]))[0]!.status).toBe("invalid");
  });
});
