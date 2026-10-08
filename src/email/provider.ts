// What a provider attempt can end in. The difference between "not_sent" and
// "unknown" decides whether trying another provider right away could duplicate.

import type { Message } from "./mime";

export type ProviderName = "gmail" | "brevo";

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
  send(m: Message, now: number): Promise<SendResult>;
  close(): Promise<void>;
}

/** Short, single-line error text with the given secrets removed (never stored or logged). */
export function cleanError(e: unknown, secrets: (string | undefined)[]): string {
  let s = String((e as Error)?.message ?? e).replace(/[\r\n]+/g, " ").slice(0, 300);
  for (const x of secrets) if (x && x.length >= 4) s = s.split(x).join("[redacted]");
  return s.slice(0, 200);
}
