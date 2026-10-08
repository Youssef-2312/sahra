// What each viewer may see of a party (address modes, feature 11 countdown).
//
// The server decides; a hidden place never reaches the browser early. Every view
// is built field by field from an allow-list, so a new column on `parties` is
// never exposed by accident. "The place" is the venue name, address and map
// link: all three are hidden together.
//
// Honest limit: once revealed to a guest, the guest can share it.

export type AddressMode = "public" | "with_ticket" | "at_time" | "manual";
export const ADDRESS_MODES: readonly AddressMode[] = ["public", "with_ticket", "at_time", "manual"];

/** The `parties` columns these views read (a full row also fits). */
export interface PartyDetailsRow {
  id: string;
  name: string;
  description: string | null;
  starts_at: number | null;
  ends_at: number | null;
  time_zone: string | null;
  venue_name: string | null;
  address: string | null;
  map_url: string | null;
  rules: string | null;
  payment_instructions: string | null;
  capacity: number;
  max_people_per_ticket: number;
  address_mode: string;
  reveal_at: number | null;
  revealed_at: number | null;
  address_locked_at: number | null;
}

/**
 * Who is looking. `ticket` is a guest's own ticket as the ticket page knows it:
 * its status ('approved' is the only one that can see a hidden place), whether it
 * has been released ("Send QR"), and whether recovery has put it on hold.
 */
export type Viewer = { kind: "public" } | { kind: "ticket"; status: string; released: boolean; onHold: boolean };

/** Why the place is still hidden from this viewer. */
export type WaitingFor =
  | "ticket"   // only for a released, approved ticket that is not on hold (public viewers always wait here)
  | "time"     // at_time: from reveal.at on
  | "owner";   // manual: until an owner/admin presses "Reveal now"

export interface VisibleParty {
  id: string;
  name: string;
  description: string | null;
  starts_at: number | null;
  ends_at: number | null;
  time_zone: string | null;
  rules: string | null;
  payment_instructions: string | null;
  max_people_per_ticket: number;
  address_mode: AddressMode;
  /** The place: all null unless this viewer may see it. */
  venue_name: string | null;
  address: string | null;
  map_url: string | null;
  /** null when the place is shown; otherwise how and when it will be (countdown when `at` is set). */
  reveal: null | { mode: AddressMode; at?: number; waiting_for: WaitingFor };
}

function mode(v: string): AddressMode {
  // An unknown value (should never happen; the column has a CHECK) is treated as the most closed mode.
  return (ADDRESS_MODES as readonly string[]).includes(v) ? (v as AddressMode) : "manual";
}

/**
 * Stable entry point (used by the guest ticket page, workstream C):
 * `visiblePartyDetails(party, viewer, now)` with `now` in Unix ms.
 *
 * The place (venue, address, map link) is returned only when:
 *  - the mode is `public` (any viewer), or
 *  - the viewer is a ticket that is approved, released and not on hold, AND
 *    the mode is `with_ticket`, or `at_time` with now >= reveal_at, or `manual`
 *    after "Reveal now" (revealed_at set).
 * Otherwise venue_name, address and map_url are null and `reveal` says what the
 * page waits for; `reveal.at` (the reveal instant) is set only in `at_time` mode.
 * No other field ever carries the place. Pure: no I/O, no clock of its own.
 */
export function visiblePartyDetails(party: PartyDetailsRow, viewer: Viewer, now: number): VisibleParty {
  const m = mode(party.address_mode);
  const ticketOk = viewer.kind === "ticket" && viewer.status === "approved" && viewer.released === true && viewer.onHold === false;
  const timeReached = party.reveal_at !== null && Number.isFinite(party.reveal_at) && now >= party.reveal_at;
  const shown =
    m === "public" ||
    (ticketOk && (m === "with_ticket" || (m === "at_time" && timeReached) || (m === "manual" && party.revealed_at !== null)));
  let reveal: VisibleParty["reveal"] = null;
  if (!shown) {
    const waiting_for: WaitingFor = !ticketOk ? "ticket" : m === "at_time" ? "time" : "owner";
    reveal = m === "at_time" && party.reveal_at !== null ? { mode: m, at: party.reveal_at, waiting_for } : { mode: m, waiting_for };
  }
  return {
    id: party.id,
    name: party.name,
    description: party.description,
    starts_at: party.starts_at,
    ends_at: party.ends_at,
    time_zone: party.time_zone,
    rules: party.rules,
    payment_instructions: party.payment_instructions,
    max_people_per_ticket: party.max_people_per_ticket,
    address_mode: m,
    venue_name: shown ? party.venue_name : null,
    address: shown ? party.address : null,
    map_url: shown ? party.map_url : null,
    reveal,
  };
}

/** Door staff: what the door needs on the night (name, times, the place), whatever the address mode. */
export function doorView(p: PartyDetailsRow) {
  return {
    id: p.id, name: p.name, starts_at: p.starts_at, ends_at: p.ends_at, time_zone: p.time_zone,
    venue_name: p.venue_name, address: p.address, map_url: p.map_url,
  };
}

/** Owners and admins: every detail and setting. */
export function staffView(p: PartyDetailsRow, now: number) {
  return {
    id: p.id, name: p.name, description: p.description, starts_at: p.starts_at, ends_at: p.ends_at, time_zone: p.time_zone,
    venue_name: p.venue_name, address: p.address, map_url: p.map_url, rules: p.rules,
    payment_instructions: p.payment_instructions, capacity: p.capacity, max_people_per_ticket: p.max_people_per_ticket,
    address_mode: mode(p.address_mode), reveal_at: p.reveal_at, revealed_at: p.revealed_at,
    address_locked_at: p.address_locked_at,
    address_locked: p.address_locked_at !== null && p.address_locked_at <= now,
  };
}
