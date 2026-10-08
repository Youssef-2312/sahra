// Types for scripts/site-owner-sql.mjs (used by the tests).
export function normalizeEmail(email: string): string | null;
export function siteOwnerSql(a: { name: string; email: string; id: string; op: string; now: number; days?: number }): { email: string; statements: string[] };
