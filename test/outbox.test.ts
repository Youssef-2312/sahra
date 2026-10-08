// The outbox base: rows exist only when their guarded change happens; no emojis.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { D1Driver } from "../src/db/driver";
import { sql } from "../src/db/sql";
import { newId } from "../src/lib/crypto";
import { outboxInsert } from "../src/outbox";
import { seedParty } from "./helpers";

const row = (partyId: string, needsApproval: boolean, body = "Your ticket is ready.") => ({
  id: newId(), partyId, kind: "ticket_released", toEmail: "guest@example.com", subject: "Your ticket", bodyText: body,
  now: 1000, createdBy: null, needsApproval,
});

describe("outbox", () => {
  it("adds a row only when its guard holds, queued or awaiting approval", async () => {
    const party = await seedParty();
    const d = new D1Driver(env.DB);
    const a = row(party, false), b = row(party, true), c = row(party, false);
    await d.batch([outboxInsert(a, sql`1`), outboxInsert(b, sql`1`), outboxInsert(c, sql`0`)]);
    const got = (await env.DB.prepare("SELECT id, status, next_attempt_at FROM outbox WHERE party_id = ? ORDER BY status").bind(party).all()).results;
    expect(got).toEqual([
      { id: b.id, status: "awaiting_approval", next_attempt_at: null },
      { id: a.id, status: "queued", next_attempt_at: 1000 },
    ]);
  });

  it("refuses emojis", () => {
    expect(() => outboxInsert(row("p", false, "Party time \u{1F389}"), sql`1`)).toThrow(/emojis/);
  });
});
