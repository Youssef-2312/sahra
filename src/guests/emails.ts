// Guest emails (outbox rows). Plain text, no emojis (brief rule 6). Names typed by
// guests or organisers may contain emojis; they are removed here, so a party or
// guest name can never make a release fail.

import type { SqlDriver } from "../db/driver";
import { sql } from "../db/sql";
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

/**
 * A party's own email texts (owner-editable, migrations/0013_email_templates.sql).
 * NULL means Sahra's default text. Placeholders are validated when saved
 * (src/party/input.ts); every value put in is plain text.
 */
export interface EmailTemplates {
  email_ticket_subject: string | null;
  email_ticket_body: string | null;
  email_link_subject: string | null;
  email_link_body: string | null;
}

export const NO_TEMPLATES: EmailTemplates = { email_ticket_subject: null, email_ticket_body: null, email_link_subject: null, email_link_body: null };

/** One primary-key read; a missing party or an older database means the defaults. */
export async function emailTemplates(d: SqlDriver, partyId: string): Promise<EmailTemplates> {
  try {
    const r = await d.all<EmailTemplates>(sql`SELECT email_ticket_subject, email_ticket_body, email_link_subject, email_link_body
      FROM parties WHERE id = ${partyId}`);
    return r.results[0] ?? NO_TEMPLATES;
  } catch {
    return NO_TEMPLATES;
  }
}

/** Fills {placeholders}; names come from a fixed list (validated when the template was saved). */
export function fill(template: string, values: Record<string, string>): string {
  return template.replace(/\{([a-z_]+)\}/g, (m, k: string) => (k in values ? values[k]! : m));
}

export function releasedEmail(a: { origin: string; partyId: string; partyName: string; ticketId: string; to: string;
  guestName: string | null; people: number; link: string; now: number; actor: string; templates?: EmailTemplates }): OutboxRow {
  const party = plain(a.partyName);
  const group = groupNote(a.people);
  const url = `${a.origin}${linkPath(a.link)}`;
  const values = { guest_name: plain(a.guestName) || "there", party_name: party, link: url, people_note: group ?? "" };
  const t = a.templates ?? NO_TEMPLATES;
  return {
    id: newId(), partyId: a.partyId, kind: "ticket_released", toEmail: a.to, ticketId: a.ticketId,
    subject: t.email_ticket_subject ? plain(fill(t.email_ticket_subject, values)) : `Your ticket for ${party}`,
    bodyText: t.email_ticket_body
      ? `${fill(t.email_ticket_body, values).replace(/\n{3,}/g, "\n\n").trim()}\n`
      : `Hello ${values.guest_name},\n\nYour ticket for ${party} is ready. Open it here to see your QR code:\n${url}\n\n${group ? `${group}\n\n` : ""}Keep this link private: anyone with it can show your QR code.\n`,
    now: a.now, createdBy: a.actor, needsApproval: false,
  };
}

export function linkEmail(a: { id: string; origin: string; partyId: string; partyName: string; to: string;
  links: string[]; ticketId: string | null; now: number; createdBy: string | null; templates?: EmailTemplates }): OutboxRow {
  const party = plain(a.partyName);
  const lines = a.links.map((l) => `${a.origin}${linkPath(l)}`).join("\n");
  const t = a.templates ?? NO_TEMPLATES;
  const values = { party_name: party, links: lines };
  return {
    id: a.id, partyId: a.partyId, kind: "ticket_link", toEmail: a.to, ticketId: a.ticketId,
    subject: t.email_link_subject ? plain(fill(t.email_link_subject, values)) : `Your ticket link for ${party}`,
    bodyText: t.email_link_body
      ? `${fill(t.email_link_body, values).replace(/\n{3,}/g, "\n\n").trim()}\n`
      : `Hello,\n\nHere is the link to your ticket for ${party}:\n${lines}\n\nKeep this link private: anyone with it can see your ticket.\nIf you did not ask for this email, you can ignore it.\n`,
    now: a.now, createdBy: a.createdBy, needsApproval: false,
  };
}

/**
 * "Find my tickets": one email with the links to every ticket of this address
 * across parties (brainstorm idea 4). Sahra's own text (no party templates: it
 * covers several parties).
 */
export function findEmail(a: { id: string; origin: string; partyId: string; to: string; now: number;
  items: { partyName: string; when: string | null; link: string }[] }): OutboxRow {
  const blocks = a.items.map((i) => `${plain(i.partyName)}${i.when ? ` (${i.when})` : ""}\n${a.origin}${linkPath(i.link)}`).join("\n\n");
  return {
    id: a.id, partyId: a.partyId, kind: "ticket_link", toEmail: a.to, ticketId: null,
    subject: a.items.length === 1 ? "Your Sahra ticket" : "Your Sahra tickets",
    bodyText: `Hello,\n\nHere ${a.items.length === 1 ? "is the link to your ticket" : "are the links to your tickets"}:\n\n${blocks}\n\n` +
      "Keep these links private: anyone with a link can see that ticket.\nIf you did not ask for this email, you can ignore it.\n",
    now: a.now, createdBy: null, needsApproval: false,
  };
}
