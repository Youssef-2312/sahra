// Time zones for party times. Times are stored as UTC instants (Unix ms) plus
// the party's IANA time zone; these helpers only validate a zone, convert a local
// wall time entered by an owner into an instant, and format an instant for
// display (e.g. in a notice email). Comparisons (reveal_at, address lock) always
// use the stored instants, never local times.

const formats = new Map<string, Intl.DateTimeFormat>();

function fmt(tz: string): Intl.DateTimeFormat {
  let f = formats.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    });
    formats.set(tz, f);
  }
  return f;
}

/** An IANA zone name such as "Africa/Cairo" or "UTC" that the runtime knows. Offsets like "+02:00" are refused. */
export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length > 64 || !/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/.test(tz)) return false;
  try {
    fmt(tz);
    return true;
  } catch {
    return false;
  }
}

function parts(t: number, tz: string) {
  const o: Record<string, number> = {};
  for (const p of fmt(tz).formatToParts(t)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return o as { year: number; month: number; day: number; hour: number; minute: number };
}

/** The instant `t` as local wall time in `tz`: "YYYY-MM-DDTHH:MM". */
export function formatLocal(t: number, tz: string): string {
  const p = parts(t, tz);
  const d2 = (n: number) => String(n).padStart(2, "0");
  return `${String(p.year).padStart(4, "0")}-${d2(p.month)}-${d2(p.day)}T${d2(p.hour)}:${d2(p.minute)}`;
}

/** For emails and pages: "2026-10-31 21:00 (Africa/Cairo)". */
export function formatHuman(t: number, tz: string): string {
  return `${formatLocal(t, tz).replace("T", " ")} (${tz})`;
}

function offsetMs(t: number, tz: string): number {
  const p = parts(t, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(t / 60_000) * 60_000;
}

/**
 * Local wall time "YYYY-MM-DDTHH:MM" in `tz` to a UTC instant. Returns null for a
 * malformed value or a time that does not exist in that zone (the hour skipped
 * when clocks go forward). In the repeated hour when clocks go back, the earlier
 * of the two instants is chosen.
 */
export function zonedToUtc(local: unknown, tz: string): number | null {
  if (typeof local !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) return null;
  const guess = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!);
  if (!Number.isFinite(guess)) return null;
  // Try the offsets in effect a day either side; keep the candidates that map back exactly.
  const candidates = [...new Set([offsetMs(guess - 86_400_000, tz), offsetMs(guess, tz), offsetMs(guess + 86_400_000, tz)])]
    .map((off) => guess - off)
    .filter((t) => formatLocal(t, tz) === local)
    .sort((a, b) => a - b);
  return candidates[0] ?? null;
}

/** A new party's zone when the creator's connection does not say (owner decision: Egypt). */
export const DEFAULT_TIME_ZONE = "Africa/Cairo";
