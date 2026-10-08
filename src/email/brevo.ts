// Brevo (free plan) transactional email API, the fallback when Gmail fails or is
// at its cap. One HTTPS POST per message through an injectable fetch.

import type { Message } from "./mime";
import { cleanError, type Provider, type SendResult } from "./provider";

export const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

export interface BrevoConfig {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  apiKey: string;
  sender: string;
  senderName: string;
  timeoutMs: number;
}

export class BrevoProvider implements Provider {
  readonly name = "brevo" as const;
  private dead: string | null = null;

  constructor(private readonly cfg: BrevoConfig) {}

  async send(m: Message): Promise<SendResult> {
    if (this.dead) return { status: "not_sent", error: `brevo unavailable this run: ${this.dead}`, providerDown: true };
    let res: Response;
    try {
      res = await this.cfg.fetch(BREVO_URL, {
        method: "POST",
        headers: { "api-key": this.cfg.apiKey, "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          sender: { email: this.cfg.sender, name: this.cfg.senderName },
          to: [{ email: m.to }],
          subject: m.subject,
          textContent: m.text,
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (e) {
      // The request may have reached Brevo: do not fall back, retry later.
      this.dead = "request failed";
      return { status: "unknown", error: cleanError(e, [this.cfg.apiKey]) };
    }
    if (res.status === 201 || res.status === 202 || res.status === 200) return { status: "sent" };
    let detail = "";
    try {
      const b = (await res.json()) as { code?: unknown; message?: unknown };
      detail = `${String(b.code ?? "")} ${String(b.message ?? "")}`.trim();
    } catch {
      // No JSON body.
    }
    const error = cleanError(`brevo ${res.status} ${detail}`, [this.cfg.apiKey]);
    if (res.status === 401 || res.status === 403) {
      this.dead = "not authorized";
      return { status: "not_sent", error, providerDown: true };
    }
    if (res.status === 429 || res.status === 402) {
      // 429: too many requests; 402: out of free credits for today.
      this.dead = "rate limited";
      return { status: "not_sent", error, providerDown: true, quotaExhausted: res.status === 402 };
    }
    if (res.status === 400) return { status: "rejected", error };
    if (res.status >= 500) {
      // A server error may or may not have queued the message.
      this.dead = `server error ${res.status}`;
      return { status: "unknown", error };
    }
    this.dead = `status ${res.status}`;
    return { status: "not_sent", error, providerDown: true };
  }

  async close(): Promise<void> {}
}
