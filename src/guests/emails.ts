// Guest emails (outbox rows). Plain text, no emojis (brief rule 6). Names typed by
// guests or organisers may contain emojis; they are removed here, so a party or
// guest name can never make a release fail.

import { newId } from "../lib/crypto";
import type { OutboxRow } from "../outbox";
import { linkPath } from "./link";

export function plain(s: string | null | undefined): string {
  return (s ?? "").replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "").replace(/\s+/g, " ").trim();
}

/** One QR admits the whole group at once (owner decision): said on the ticket page and in the release email. */
export function groupNote(people: number): string | null {
  return people > 1 ? `This QR admits ${people} people together; arrive together.` : null;
}

export function releasedEmail(a: { origin: string; partyId: string; partyName: string; ticketId: string; to: string;
  guestName: string | null; people: number; link: string; now: number; actor: string }): OutboxRow {
  const party = plain(a.partyName);
  const group = groupNote(a.people);
  return {
    id: newId(), partyId: a.partyId, kind: "ticket_released", toEmail: a.to, ticketId: a.ticketId,
    subject: `Your ticket for ${party}`,
    bodyText: `Hello ${plain(a.guestName) || "there"},\n\nYour ticket for ${party} is ready. Open it here to see your QR code:\n${a.origin}${linkPath(a.link)}\n\n${group ? `${group}\n\n` : ""}Keep this link private: anyone with it can show your QR code.\n`,
    now: a.now, createdBy: a.actor, needsApproval: false,
  };
}

export function linkEmail(a: { id: string; origin: string; partyId: string; partyName: string; to: string;
  links: string[]; ticketId: string | null; now: number; createdBy: string | null }): OutboxRow {
  const party = plain(a.partyName);
  const lines = a.links.map((l) => `${a.origin}${linkPath(l)}`).join("\n");
  return {
    id: a.id, partyId: a.partyId, kind: "ticket_link", toEmail: a.to, ticketId: a.ticketId,
    subject: `Your ticket link for ${party}`,
    bodyText: `Hello,\n\nHere is the link to your ticket for ${party}:\n${lines}\n\nKeep this link private: anyone with it can see your ticket.\nIf you did not ask for this email, you can ignore it.\n`,
    now: a.now, createdBy: a.createdBy, needsApproval: false,
  };
}
