// What a provider attempt can end in. The difference between "not_sent" and
// "unknown" decides whether trying another provider right away could duplicate.

import type { Message } from "./mime";

/** Up to three platform Gmail accounts (each with its own daily cap), then Brevo. */
export const PROVIDER_NAMES = ["gmail", "gmail2", "gmail3", "brevo"] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export type SendResult =
  | { status: "sent" }
  /** Definitely not accepted (connection or login failed, temporary refusal before the end of DATA). */
  | { status: "not_sent"; error: string; providerDown?: boolean; quotaExhausted?: boolean }
  /** The message may have been accepted (connection lost or timeout after the end of DATA). */
  | { status: "unknown"; error: string }
  /** Permanently refused (bad recipient, message rejected): retrying will not help. */
  | { status: "rejected"; error: string };

export interface Provider {
  readonly name: ProviderName;
  /** The address this provider sends from. */
  readonly fromEmail: string;
  send(m: Message, now: number): Promise<SendResult>;
  close(): Promise<void>;
}

/** Short, single-line error text with the given secrets removed (never stored or logged). */
export function cleanError(e: unknown, secrets: (string | undefined)[]): string {
  let s = String((e as Error)?.message ?? e).replace(/[\r\n]+/g, " ").slice(0, 300);
  for (const x of secrets) if (x && x.length >= 4) s = s.split(x).join("[redacted]");
  return s.slice(0, 200);
}
