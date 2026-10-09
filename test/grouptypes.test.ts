// Group and single tickets (migrations/0021_type_people.sql): a ticket type can set
// how many people one ticket admits (min_people, max_people; NULL = the party's
// rule). Checked by the server in the request and issue statements.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Driver } from "../src/db/driver";
import { GuestDb } from "../src/guests/db";
import { PRIVACY_VERSION, TERMS_VERSION } from "../src/guests/policy";
import { newId } from "../src/lib/crypto";
import { clearPartyListCache } from "../src/routes/guests";
import { api, guestParty, harness, signupInit, type Harness } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
});
afterEach(() => vi.restoreAllMocks());

type Sess = { token: string; csrf: string };
async function createType(h: Harness, os: Sess, body: Record<string, unknown>) {
  const r = await h.req("/api/tickets/types", api(os, { op: newId(), ...body }));
  return { status: r.status, body: (await r.json()) as { type?: { id: string; min_people: number | null; max_people: number | null }; error?: string } };
}
async function request(h: Harness, party: string, typeId: string, people: number) {
  const init = await signupInit({ people, screenshot: null });
  const body = init.body as Uint8Array;
  const boundary = /boundary=(.*)$/.exec((init.headers as Record<string, string>)["content-type"]!)![1]!;
  const extra = new TextEncoder().encode(`--${boundary}\r\nContent-Disposition: form-data; name="type_id"\r\n\r\n${typeId}\r\n`);
  const full = new Uint8Array([...extra, ...body]);
  const r = await h.req(`/api/guest/parties/${party}/signup`, { ...init, body: full, headers: { ...(init.headers as Record<string, string>), "content-length": String(full.length) } });
  return { status: r.status, body: (await r.json()) as { error?: string; ticket_id?: string } };
}

describe("group and single ticket types", () => {
  it("owner sets people per ticket per type; guests are held to it, even past the party's own limit", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { maxPeople: 4, form: { questions: [], screenshot: "optional" } });
    const single = await createType(h, os, { name: "Normal", price: 300, min_people: 1, max_people: 1 });
    const group = await createType(h, os, { name: "Group", price: 250, min_people: 2, max_people: 6 });
    expect(single.status).toBe(201);
    expect(group.body.type).toMatchObject({ min_people: 2, max_people: 6 });
    expect((await createType(h, os, { name: "Odd", price: 1, min_people: 5, max_people: 2 })).body.error).toBe("people_min_above_max");
    expect((await createType(h, os, { name: "Big", price: 1, max_people: 51 })).body.error).toBe("invalid_field:max_people");

    const form = (await (await h.req(`/api/guest/parties/${party}`)).json()) as { types: { name: string; min_people: number; max_people: number }[] };
    expect(form.types.map((x) => [x.name, x.min_people, x.max_people]).sort()).toEqual([["Group", 2, 6], ["Normal", 1, 1]]);

    expect((await request(h, party, single.body.type!.id, 2)).body.error).toBe("too_many_people");
    expect((await request(h, party, group.body.type!.id, 1)).body.error).toBe("too_few_people");
    expect((await request(h, party, group.body.type!.id, 7)).body.error).toBe("too_many_people");
    const ok = await request(h, party, group.body.type!.id, 6); // beyond the party's 4: the type says 6
    expect(ok.status).toBe(201);
    expect(await env.DB.prepare("SELECT people FROM tickets WHERE id = ?").bind(ok.body.ticket_id).first("people")).toBe(6);
    expect((await request(h, party, single.body.type!.id, 1)).status).toBe(201);

    // Edits keep min <= max, in the statement too.
    const e = await h.req(`/api/tickets/types/${group.body.type!.id}`, api(os, { op: newId(), min_people: 8 }));
    expect(((await e.json()) as { error: string }).error).toBe("people_min_above_max");
  });

  it("the rule is inside the request statement, and staff-issued tickets follow it too", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { maxPeople: 4 });
    const group = (await createType(h, os, { name: "Group", price: 250, min_people: 2, max_people: 6 })).body.type!;
    const r = await new GuestDb(new D1Driver(env.DB)).signup({
      id: "GRPTESTGRPTEST00", partyId: party, people: 1, name: "G", email: "g@example.com", answers: null, screenshotKey: null,
      typeId: group.id, now: h.clock.now(), op: newId(), rules: null, cancellation: null,
      accepted: { terms: TERMS_VERSION, rules: null, privacy: PRIVACY_VERSION },
    });
    expect(r).toBe("people_out_of_range");
    const issue = (people: number) => h.req("/api/tickets/issue", api(os, { op: newId(), name: "Door list", people, type_id: group.id }));
    expect((await issue(7)).status).toBe(400);
    expect((await issue(5)).status).toBe(201);
  });
});
