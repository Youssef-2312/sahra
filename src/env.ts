export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  ASSETS?: Fetcher;
  RL_AUTH?: RateLimit;
  RL_SCAN?: RateLimit;
  PUBLIC_ORIGIN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET?: string;
  ENABLE_PROTO?: string;
  QR_MASTER_K1?: string;
  LINK_MASTER_K1?: string;
}

export const CONFIG = {
  /** Google sign-in attempt (state/nonce/PKCE + Lax binding cookie). */
  loginAttemptMs: 10 * 60_000,
  /** Party picker grant after sign-in, for accounts at more than one party. */
  loginGrantMs: 5 * 60_000,
  /** Owner/admin session lifetime. */
  googleSessionMs: 12 * 3600_000,
  /** Door session lifetime, counted from joining. */
  doorSessionMs: 16 * 3600_000,
  /** Default and maximum invitation lifetimes. */
  doorInviteDefaultHours: 72,
  googleInviteDefaultHours: 7 * 24,
  inviteMaxHours: 14 * 24,
} as const;
