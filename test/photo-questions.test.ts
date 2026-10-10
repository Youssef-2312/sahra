import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Driver } from "../src/db/driver";
import { GuestDb } from "../src/guests/db";
import { checkAnswers, parseForm } from "../src/guests/form";
import { PRIVACY_VERSION, TERMS_VERSION } from "../src/guests/policy";
import { newId, newToken } from "../src/lib/crypto";
import { clearPartyListCache } from "../src/routes/guests";
import { FileStore, MAX_FILE_BYTES, purgeOldScreenshots, answerPhotoOwner, resetUploadTarget } from "../src/storage";
import { api, backupGet, guestParty, harness, JPEG, PNG, seedDoor, seedSession, signup } from "./helpers";

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); clearPartyListCache(); resetUploadTarget(); });
afterEach(() => vi.restoreAllMocks());
const question = (id = "picture", required = true) => ({ id, label: "Your photo / صورتك", type: "photo", required });
const form = (required = true) => ({ questions: [question("picture", required)], screenshot: "optional" });
const get = (sess: Parameters<typeof api>[0]) => ({ ...api(sess), method: "GET", body: undefined });
const path = (id: string, q = "picture") => `/api/tickets/${id}/answers/${q}/photo`;
const row = async (id: string) => (await env.DB.prepare("SELECT answers FROM tickets WHERE id = ?").bind(id).first<{ answers: string }>())!;

describe("photo questions", () => {
  it("allows up to three and requires actual uploads, never client-supplied references", () => {
    expect(parseForm({ questions: [question("a"), question("b"), question("c")] })).not.toBeNull();
    expect(parseForm({ questions: [question("a"), question("b"), question("c"), question("d")] })).toBeNull();
    expect(parseForm({ questions: [{ ...question(), options: ["x"] }] })).toBeNull();
    const f = parseForm(form())!;
    expect(checkAnswers(f, {})).toEqual({});
    expect(checkAnswers(f, { picture: { photo: "f1:1" } })).toBeNull();
  });

  it("stores private photos, isolates each question and preserves retry identity", async () => {
    const h = await harness();
    const { party, os } = await guestParty(h, { form: { ...form(), questions: [question(), question("other")] } });
    expect((await signup(h, party)).body.error).toBe("photo_required");
    const token = newToken();
    const f = { signup: token, photos: { picture: PNG, other: JPEG } };
    const a = await signup(h, party, f);
    expect(a.status).toBe(201);
    const id = a.body.ticket_id!;
    const answers = JSON.parse((await row(id)).answers);
    expect(answers.picture).not.toBe(answers.other);
    const img = await h.req(path(id), get(os));
    expect(img.status).toBe(200);
    expect(img.headers.get("cache-control")).toContain("no-store");
    expect(img.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await img.arrayBuffer())).toEqual(PNG);
    expect(new Uint8Array(await (await h.req(path(id, "other"), get(os))).arrayBuffer())).toEqual(JPEG);
    expect(new Uint8Array(await (await h.req(`/api/tickets/${id}/screenshot`, get(os))).arrayBuffer())).toEqual(PNG);
    const again = await signup(h, party, f);
    expect(again.status).toBe(200);
    expect(again.body.ticket_id).toBe(id);
    expect(JSON.parse((await row(id)).answers)).toEqual(answers);
    const count = await env.FILES!.prepare("SELECT COUNT(*) AS n FROM files WHERE party_id = ?").bind(party).first<{ n: number }>();
    expect(count!.n).toBe(3);
    expect((await h.req(path(id))).status).toBe(401);
    const door = await seedDoor(party, h.clock);
    expect((await h.req(path(id), get(await seedSession(party, door.id, "door", h.clock)))).status).toBe(403);
    const other = await guestParty(h);
    expect((await h.req(path(id), get(other.os))).status).toBe(404);
    expect((await h.req(path(id, "unknown"), get(os))).status).toBe(404);
    // Removing a question later does not remove a manager's access to an existing answer.
    await env.DB.prepare("UPDATE parties SET guest_form = NULL WHERE id = ?").bind(party).run();
    expect((await h.req(path(id), get(os))).status).toBe(200);
    const key = answers.picture.slice(6).split(":");
    const backedUp = await backupGet(h, `/api/backup/file/files/${key[1]}`);
    expect(backedUp.status).toBe(200);
    expect(new Uint8Array(await backedUp.arrayBuffer())).toEqual(PNG);
  });

  it("allows optional answers and refuses forged, unexpected, oversized or non-image uploads", async () => {
    const h = await harness(); const { party } = await guestParty(h, { form: form(false) });
    expect((await signup(h, party, { screenshot: null })).status).toBe(201);
    expect((await signup(h, party, { answers: { picture: "f1:1" } })).body.error).toBe("invalid_answers");
    expect((await signup(h, party, { photos: { unknown: PNG } })).body.error).toBe("invalid_answers");
    expect((await signup(h, party, { photos: { picture: new TextEncoder().encode("<svg/>") } })).status).toBe(415);
    expect((await signup(h, party, { photos: { picture: new Uint8Array(MAX_FILE_BYTES + 1) } })).status).toBe(413);
    const noFiles = await harness({ env: { FILES: undefined } });
    expect((await signup(noFiles, party, { screenshot: null, photos: { picture: PNG } })).body.error).toBe("uploads_not_configured");
  });

  it.each(["ended", "rejected", "cancelled"])("purges photo bytes and backup downloads after seven days: %s", async (reason) => {
    const h = await harness(); const { party, os } = await guestParty(h, { form: form() });
    const a = await signup(h, party, { photos: { picture: PNG }, screenshot: null });
    const id = a.body.ticket_id!; const now = h.clock.now(); const day = 86400000;
    const key = JSON.parse((await row(id)).answers).picture.slice(6).split(":");
    await purgeOldScreenshots(env, new D1Driver(env.DB), now);
    expect((await h.req(path(id), get(os))).status).toBe(200);
    if (reason === "ended") await env.DB.prepare("UPDATE parties SET ends_at = ? WHERE id = ?").bind(now - 8 * day, party).run();
    else if (reason === "rejected") await env.DB.prepare("UPDATE tickets SET status = 'rejected', rejected_at = ? WHERE id = ?").bind(now - 8 * day, id).run();
    else await env.DB.prepare("UPDATE tickets SET status = 'cancelled', cancelled_at = ? WHERE id = ?").bind(now - 8 * day, id).run();
    await purgeOldScreenshots(env, new D1Driver(env.DB), now);
    expect((await h.req(path(id), get(os))).status).toBe(410);
    expect((await backupGet(h, `/api/backup/file/files/${key[1]}`)).status).toBe(410);
  });

  it("purges uncommitted photo uploads after one day", async () => {
    const h = await harness(); const { party } = await guestParty(h);
    const store = FileStore.for(env, 1)!;
    await store.put({ id: 123, partyId: party, ticketId: answerPhotoOwner("0000000000000001", "picture"), type: "image/png", bytes: PNG, now: h.clock.now() - 2 * 86400000 });
    await purgeOldScreenshots(env, new D1Driver(env.DB), h.clock.now());
    expect(await store.get(123, party, answerPhotoOwner("0000000000000001", "picture"))).toHaveProperty("deleted");
  });

  it("refuses a signup if the host changed the question schema during upload", async () => {
    const h = await harness(); const { party } = await guestParty(h, { form: form() });
    const id = newId();
    const result = await new GuestDb(new D1Driver(env.DB)).signup({
      id, partyId: party, people: 1, name: "Guest", email: "guest@example.test", answers: null,
      screenshotKey: null, typeId: null, now: h.clock.now(), op: newId(), guestForm: null,
      rules: null, cancellation: null, accepted: { terms: TERMS_VERSION, rules: null, privacy: PRIVACY_VERSION },
    });
    expect(result).toBe("form_changed");
    expect(await row(id)).toBeNull();
  });
});
