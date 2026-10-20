/** Inclusive start and exclusive end, epoch milliseconds. Calendar-day conversion
 * belongs to the browser's explicitly labelled device timezone. */
export interface DateRange { createdFrom?: number; createdBefore?: number }
export function parseDateRange(from: string | undefined, before: string | undefined): DateRange | false {
  const bound = (value: string | undefined): number | undefined | false => {
    if (value === undefined) return undefined;
    if (!/^\d{1,16}$/.test(value)) return false;
    const n = Number(value);
    return Number.isSafeInteger(n) && n >= 0 && n <= 8640000000000000 ? n : false;
  };
  const start = bound(from), end = bound(before);
  if (start === false || end === false || (start !== undefined && end !== undefined && start >= end)) return false;
  return { createdFrom: start, createdBefore: end };
}
