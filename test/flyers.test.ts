// Party pictures (migrations/0016_party_flyers.sql, src/party/flyers.ts): owner/admin
// upload, list and delete; at most MAX_FLYERS live per party (counted in the INSERT);
// guests load them only for parties that are switched on and not over; the home
// page list and the party page carry them; the daily purge keeps live pictures and
// empties deleted ones, those of parties over for 30 days, and failed uploads.
import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "../src/lib/crypto";
import { MAX_FLYERS } from "../src/party/flyers";
import { clearFlyerCache, clearPartyListCache } from "../src/routes/guests";
import { purgeOldScreenshots, resetUploadTarget } from "../src/storage";
import { D1Driver } from "../src/db/driver";
import { api, guestParty, harness, logEntry, ORIGIN, seedDoor, seedSession, type Harness } from "./helpers";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  clearPartyListCache();
  clearFlyerCache();
  resetUploadTarget();
});
afterEach(() => vi.restoreAllMocks());

type Sess = { token: string; csrf: string };
const JPEG = (n = 0) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, n & 255, (n >> 8) & 255]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

async function upload(h: Harness, os: Sess | null, bytes: Uint8Array, op = newId(), name = "a.jpg") {
  const fd = new FormData();
  fd.set("op", op);
  fd.set("file", new File([bytes], name));
  const body = new Response(fd);
  const buf = new Uint8Array(await body.arrayBuffer());
  const headers: Record<string, string> = { origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": body.headers.get("content-type")!,
    "content-length": String(buf.length) };
  if (os) headers["x-sahra-csrf"] = os.csrf;
  const r = await h.req("/api/party/flyers", { method: "POST", headers, body: buf, cookies: os ? { "__Host-sahra_s": os.token } : {} });
  return { status: r.status, body: (await r.json()) as { status?: string; error?: string; flyer?: { id: string; url: string } | null } };
}
async function list(h: Harness, os: Sess) {
  const r = await h.req("/api/party/flyers", { ...api(os), method: "GET", body: undefined });
  return { status: r.status, body: (await r.json()) as { flyers: { id: string; url: string; position: number }[]; max: number } };
}
async function listed(h: Harness, party: string, startsAt: number) {
  await env.DB.prepare("UPDATE parties SET starts_at = ? WHERE id = ?").bind(startsAt, party).run();
  clearPartyListCache();
}

describe("party pictures", () => {
  it("owner uploads pictures in order; logged and audited; a retry with the same op is the same picture", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const op = newId();
    const a = await upload(h, os, JPEG(1), op);
    expect(a.status).toBe(201);
    expect(a.body.status).toBe("created");
    const again = await upload(h, os, JPEG(1), op);
    expect(again.status).toBe(200);
    expect(again.body.status).toBe("already");
    expect(again.body.flyer!.id).toBe(a.body.flyer!.id);
    const b = await upload(h, os, PNG);
    expect(b.status).toBe(201);
    const l = await list(h, os);
    expect(l.body.flyers.map((f) => f.id)).toEqual([a.body.flyer!.id, b.body.flyer!.id]);
    expect(l.body.max).toBe(MAX_FLYERS);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM party_flyers WHERE party_id = ?").bind(party).first("n")).toBe(2);
    expect(((await logEntry("flyer", a.body.flyer!.id, 1)) as { action?: string } | null)?.action).toBe("flyer_added");
    expect(await env.DB.prepare("SELECT action FROM audit WHERE entity_type = 'flyer' AND entity_id = ?").bind(a.body.flyer!.id).first("action"))
      .toBe("flyer_added");
  });

  it("allows up to the limit, refuses one more, and refuses wrong types, bad sessions and door staff", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    for (let i = 0; i < MAX_FLYERS; i++) expect((await upload(h, os, JPEG(i))).status).toBe(201);
    const over = await upload(h, os, JPEG(99));
    expect(over.status).toBe(409);
    expect(over.body.error).toBe("too_many_flyers");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM party_flyers WHERE party_id = ? AND deleted_at IS NULL").bind(party).first("n")).toBe(MAX_FLYERS);

    const { party: p2, os: os2 } = await guestParty(h);
    expect((await upload(h, os2, new TextEncoder().encode("<svg></svg>"), newId(), "a.svg")).status).toBe(415);
    expect((await upload(h, null, JPEG())).status).toBe(401);
    const door = await seedDoor(p2, h.clock);
    const ds = await seedSession(p2, door.id, "door", h.clock);
    expect((await upload(h, ds, JPEG())).status).toBe(403);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM party_flyers WHERE party_id = ?").bind(p2).first("n")).toBe(0);
  });

  it("the limit holds inside the statement even when two uploads race", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    for (let i = 0; i < MAX_FLYERS - 1; i++) expect((await upload(h, os, JPEG(i))).status).toBe(201);
    const rs = await Promise.all([upload(h, os, JPEG(50)), upload(h, os, JPEG(51)), upload(h, os, JPEG(52))]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM party_flyers WHERE party_id = ? AND deleted_at IS NULL").bind(party).first("n")).toBe(MAX_FLYERS);
  });

  it("guests load a listed party's pictures with a long cache; not after delete, or when the party is off or over", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    await listed(h, party, h.clock.now() + 86_400_000);
    const a = await upload(h, os, JPEG(7));
    const url = a.body.flyer!.url;
    const img = await h.req(url);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/jpeg");
    expect(img.headers.get("cache-control")).toContain("immutable");
    expect(img.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(JPEG(7));

    // On the home page list and the party page.
    const home = (await (await h.req("/api/guest/parties")).json()) as { parties: { id: string; flyers: { url: string }[] }[] };
    expect(home.parties.find((p) => p.id === party)!.flyers.map((f) => f.url)).toEqual([url]);
    const page = (await (await h.req(`/api/guest/parties/${party}`)).json()) as { flyers: { url: string }[] };
    expect(page.flyers.map((f) => f.url)).toEqual([url]);

    // Switched off: no picture.
    await env.DB.prepare("UPDATE parties SET disabled_at = ? WHERE id = ?").bind(h.clock.now(), party).run();
    clearFlyerCache();
    expect((await h.req(url)).status).toBe(404);
    await env.DB.prepare("UPDATE parties SET disabled_at = NULL, starts_at = ?, ends_at = ? WHERE id = ?").bind(h.clock.now() - 86_400_000, h.clock.now() - 3_600_000, party).run();
    expect((await h.req(url)).status).toBe(404);
    await env.DB.prepare("UPDATE parties SET starts_at = ?, ends_at = NULL WHERE id = ?").bind(h.clock.now() + 86_400_000, party).run();
    expect((await h.req(url)).status).toBe(200);

    // Deleted: gone from the list and the URL.
    const del = await h.req(`/api/party/flyers/${a.body.flyer!.id}/delete`, api(os, { op: newId() }));
    expect(del.status).toBe(200);
    expect(((await del.json()) as { status: string }).status).toBe("deleted");
    expect((await h.req(url)).status).toBe(404);
    expect((await list(h, os)).body.flyers).toEqual([]);
    const del2 = await h.req(`/api/party/flyers/${a.body.flyer!.id}/delete`, api(os, { op: newId() }));
    expect(((await del2.json()) as { status: string }).status).toBe("already");
    // Another party's owner cannot delete or see it.
    const { os: other } = await guestParty(h);
    expect((await h.req(`/api/party/flyers/${a.body.flyer!.id}/delete`, api(other, { op: newId() }))).status).toBe(404);
  });

  it("the daily purge keeps live pictures and empties deleted ones, those of ended parties and failed uploads", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h);
    const now = h.clock.now();
    await listed(h, party, now + 86_400_000);
    const keep = (await upload(h, os, JPEG(1))).body.flyer!;
    const gone = (await upload(h, os, JPEG(2))).body.flyer!;
    await h.req(`/api/party/flyers/${gone.id}/delete`, api(os, { op: newId() }));
    // A file no picture row points to (an upload refused after storing), older than a day.
    await env.FILES!.prepare("INSERT INTO files (id, party_id, ticket_id, content_type, size, bytes, created_at) VALUES (?, ?, ?, 'image/jpeg', 3, x'ffd8ff', ?)")
      .bind(987654321, party, "flyer:ZZZZZZZZZZZZZZZZ", now - 2 * 86_400_000).run();
    const main = new D1Driver(env.DB);
    // What the purge decided for this party's files (other tests in this file leave their own).
    const reasons = async () => (await env.FILES!.prepare(`SELECT f.ticket_id, d.reason FROM files f LEFT JOIN file_tombstones d ON d.id = f.id
      WHERE f.party_id = ? ORDER BY f.ticket_id`).bind(party).all<{ ticket_id: string; reason: string | null }>()).results;
    await purgeOldScreenshots(env as never, main, now);
    const r1 = Object.fromEntries((await reasons()).map((x) => [x.ticket_id, x.reason]));
    expect(r1[`flyer:${keep.id}`]).toBeNull();
    expect(r1[`flyer:${gone.id}`]).toContain("deleted by the organiser");
    expect(r1["flyer:ZZZZZZZZZZZZZZZZ"]).toContain("upload that was not stored");
    expect((await h.req(keep.url)).status).toBe(200);

    // 31 days after the party: the kept picture goes too.
    await purgeOldScreenshots(env as never, main, now + 32 * 86_400_000);
    const r2 = Object.fromEntries((await reasons()).map((x) => [x.ticket_id, x.reason]));
    expect(r2[`flyer:${keep.id}`]).toContain("30 days after the party");
    const left = await env.FILES!.prepare("SELECT COUNT(*) AS n FROM files WHERE party_id = ? AND length(bytes) > 0").bind(party).first("n");
    expect(left).toBe(0);
  });
});
