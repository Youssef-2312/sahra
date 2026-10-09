// A short request reference (brainstorm idea 15) a guest can quote to the
// organiser: "SAH-" and the first 6 characters of the ticket id. It identifies a
// request to staff (who can search for it); it never opens a ticket: the signed
// private link stays the only way in.
export function referenceOf(ticketId: string): string {
  return `SAH-${ticketId.slice(0, 6)}`;
}
