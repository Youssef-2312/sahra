// ID photos and Instagram handles (migrations/0020_id_photo_instagram.sql): a
// party's form asks for each ("none", "optional", "required"), the server checks it
// on every request, the handle is reduced to Instagram's own form, the photo is
// stored like the payment screenshot and only owners and admins can open it, and
// both are deleted 7 days after the party.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Driver } from "../src/db/driver";
import { cleanInstagram } from "../src/guests/form";
import { PRIVACY_VERSION } from "../src/guests/policy";
import { eraseGuestDetails } from "../src/guests/retention";
import { clearPartyListCache } from "../src/routes/guests";
import { DELETED_REASON, purgeOldScreenshots, resetUploadTarget, type FilesEnv } from "../src/storage";
import { api, guestParty, harness, JPEG, PNG, seedDoor, seedSession, signup as signupAny, type Harness } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
  resetUploadTarget();
});
afterEach(() => vi.restoreAllMocks());

const DAY = 86_400_000;
const ID = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
const ticket = async (id: string) => (await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first<Record<string, unknown>>())!;
const asks = (id_photo: string, instagram: string) => ({ form: { questions: [], screenshot: "optional", id_photo, instagram } });
// A party that asks for an ID photo shows the notice that mentions ID checks ("+id" version).
const signup = (h: Harness, party: string, f: Parameters<typeof signupAny>[2] = {}) => signupAny(h, party, { privacy: PRIVACY_VERSION + "+id", ...f });
async function idPhoto(h: Harness, sess: { token: string; csrf: string }, id: string) {
  return h.req(`/api/tickets/${id}/id-photo`, { ...api(sess), method: "GET", body: undefined });
}

describe("Instagram handles", () => {
  it("reduces what guests type to the handle, and refuses what is not one", () => {
    for (const [given, want] of [
      ["@Mona.Ali", "mona.ali"], ["mona_ali", "mona_ali"], ["  @mona  ", "mona"],
      ["https://www.instagram.com/Mona.Ali/", "mona.ali"], ["instagram.com/mona?igsh=abc", "mona"], ["http://m.instagram.com/mona", "mona"],
    ] as const) expect(cleanInstagram(given)).toBe(want);
    for (const bad of ["", "@", "mona ali", ".mona", "mona.", "mo..na", "a".repeat(31), "mona!", "https://example.com/mona", 5])
      expect(cleanInstagram(bad)).toBeNull();
  });
});

describe("ID photos and Instagram on the request form", () => {
  it("required: refused without them, or with a handle that is not one; stored when given", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, asks("required", "required"));
    const form = ((await (await h.req(`/api/guest/parties/${party}`)).json()) as { form: Record<string, unknown> }).form;
    expect(form).toMatchObject({ id_photo: "required", instagram: "required" });
    // The notice without the ID sentence is not what this party shows.
    expect((await signupAny(h, party, { idPhoto: ID, instagram: "@mona" })).body.error).toBe("terms_changed");
    expect((await signup(h, party, { instagram: "@mona" })).body.error).toBe("id_photo_required");
    expect((await signup(h, party, { idPhoto: ID })).body.error).toBe("instagram_required");
    expect((await signup(h, party, { idPhoto: ID, instagram: "mona ali" })).body.error).toBe("invalid_instagram");
    expect((await signup(h, party, { idPhoto: new TextEncoder().encode("<svg/>"), instagram: "@mona" })).body.error).toBe("id_photo_must_be_jpeg_png_or_webp");
    const ok = await signup(h, party, { idPhoto: ID, instagram: "https://instagram.com/Mona.Ali/", screenshot: PNG });
    expect(ok.status).toBe(201);
    const t = await ticket(ok.body.ticket_id!);
    expect(t.instagram).toBe("mona.ali");
    expect(t.id_photo_key).toMatch(/^f\d+:\d+$/);
    expect(t.id_photo_key).not.toBe(t.screenshot_key);

    // The queue shows both; the owner opens the photo; it is never cached.
    const list = (await (await h.req("/api/tickets?status=pending", { ...api(os), method: "GET", body: undefined })).json()) as { tickets: { id: string; instagram: string; has_id_photo: boolean; has_screenshot: boolean }[] };
    expect(list.tickets.find((x) => x.id === ok.body.ticket_id)).toMatchObject({ instagram: "mona.ali", has_id_photo: true, has_screenshot: true });
    const img = await idPhoto(h, os, ok.body.ticket_id!);
    expect(img.status).toBe(200);
    expect(img.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(ID);
    // The screenshot is still the screenshot.
    const shot = await h.req(`/api/tickets/${ok.body.ticket_id}/screenshot`, { ...api(os), method: "GET", body: undefined });
    expect(new Uint8Array(await shot.arrayBuffer())).toEqual(PNG);

    // Door staff never; another party's owner never.
    const door = await seedDoor(party, h.clock);
    expect((await idPhoto(h, await seedSession(party, door.id, "door", h.clock), ok.body.ticket_id!)).status).toBe(403);
    const { os: other } = await guestParty(h);
    expect((await idPhoto(h, other, ok.body.ticket_id!)).status).toBe(404);
  });

  it("optional: either way; not asked: an ID photo is refused and a handle is not kept", async () => {
    const h = await harness();
    const { party } = await guestParty(h, asks("optional", "optional"));
    const plain = await signup(h, party);
    expect(plain.status).toBe(201);
    expect(await ticket(plain.body.ticket_id!)).toMatchObject({ instagram: null, id_photo_key: null });
    const { party: none } = await guestParty(h, asks("none", "none"));
    expect((await signupAny(h, none, { idPhoto: ID })).body.error).toBe("id_photo_not_wanted");
    const r = await signupAny(h, none, { instagram: "@mona" });
    expect(r.status).toBe(201);
    expect((await ticket(r.body.ticket_id!)).instagram).toBeNull();
  });

  it("an order: every friend's ticket has its own ID photo when the party requires one", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, asks("required", "none"));
    await env.DB.prepare("UPDATE parties SET max_tickets_per_email = 5 WHERE id = ?").bind(party).run();
    const A = new Uint8Array([...ID, 0xa1]), B = new Uint8Array([...ID, 0xb2]);
    // A friend without a photo: refused, and it says which ticket.
    const missing = await signup(h, party, { idPhoto: ID, tickets: 3, names: ["Rami", "Sara"], friendIdPhotos: [A, null] });
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ error: "id_photo_required", ticket: 3 });
    // A photo for a ticket that is not in the order: refused.
    expect((await signup(h, party, { idPhoto: ID, tickets: 2, names: ["Rami"], friendIdPhotos: [A, B] })).status).toBe(400);

    const ok = await signup(h, party, { idPhoto: ID, tickets: 3, names: ["Rami", "Sara"], friendIdPhotos: [A, B] });
    expect(ok.status).toBe(201);
    const tickets = (ok.body as unknown as { tickets: { ticket_id: string; name: string }[] }).tickets;
    expect(tickets.map((x) => x.name)).toEqual(["Guest Name", "Rami", "Sara"]);
    const photos = [ID, A, B];
    for (let i = 0; i < 3; i++) {
      const img = await idPhoto(h, os, tickets[i]!.ticket_id);
      expect(img.status).toBe(200);
      expect(new Uint8Array(await img.arrayBuffer())).toEqual(photos[i]);
    }
    // Not asked: a friend's photo is refused like the buyer's.
    const { party: none } = await guestParty(h, asks("none", "none"));
    expect((await signupAny(h, none, { tickets: 2, names: ["Rami"], friendIdPhotos: [A] })).body.error).toBe("id_photo_not_wanted");
  });

  it("both are deleted 7 days after the party; the photo also 7 days after a rejection", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, asks("required", "required"));
    const a = await signup(h, party, { idPhoto: ID, instagram: "@mona" });
    const b = await signup(h, party, { idPhoto: JPEG, instagram: "@rami" });
    await h.req("/api/tickets/reject", api(os, { ids: [b.body.ticket_id] }));
    const now = h.clock.now();
    // Rejected 8 days ago (the party is still ahead): only its ID photo goes.
    await env.DB.prepare("UPDATE tickets SET rejected_at = ? WHERE id = ?").bind(now - 8 * DAY, b.body.ticket_id).run();
    await env.DB.prepare("UPDATE parties SET starts_at = ?, ends_at = ? WHERE id = ?").bind(now + DAY, now + 2 * DAY, party).run();
    await purgeOldScreenshots(env as FilesEnv, new D1Driver(env.DB), now);
    expect((await idPhoto(h, os, b.body.ticket_id!)).status).toBe(410);
    expect((await idPhoto(h, os, a.body.ticket_id!)).status).toBe(200);
    // The party ended 8 days ago: the other photo and both handles go.
    await env.DB.prepare("UPDATE parties SET starts_at = ?, ends_at = ? WHERE id = ?").bind(now - 8 * DAY - 6 * 3600_000, now - 8 * DAY, party).run();
    await purgeOldScreenshots(env as FilesEnv, new D1Driver(env.DB), now);
    const gone = await idPhoto(h, os, a.body.ticket_id!);
    expect(gone.status).toBe(410);
    expect(((await gone.json()) as { message: string }).message).toBe(DELETED_REASON.id_party_ended);
    await eraseGuestDetails(new D1Driver(env.DB), new D1Driver(env.LEDGER), now);
    for (const id of [a.body.ticket_id!, b.body.ticket_id!]) expect((await ticket(id)).instagram).toBeNull();
    const logged = (await env.LEDGER.prepare("SELECT state FROM change_log WHERE entity = 'ticket' AND entity_id = ?").bind(a.body.ticket_id).all<{ state: string }>()).results;
    for (const e of logged) expect(JSON.parse(e.state).instagram).toBeNull();
  });
});
