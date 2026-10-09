// A minimal SMTP submission client (RFC 5321) for the platform's own Gmail
// account: implicit TLS on port 465, EHLO, AUTH PLAIN (or LOGIN), then per
// message MAIL FROM, RCPT TO, DATA with dot-stuffing; QUIT at the end of a run.
// One connection is reused for every message of a run. The socket is injected
// (src/email/socket.ts in the Worker, a fake in tests), so nothing here opens a
// connection by itself.

import { b64utf8, buildMessage, dotStuff, type Message } from "./mime";
import { cleanError, type Provider, type SendResult } from "./provider";

export interface SmtpSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  close(): Promise<void>;
}
export type Connect = (host: string, port: number) => SmtpSocket;

export interface SmtpConfig {
  /** Which Gmail account (gmail, gmail2, gmail3): its own caps and counts. Default gmail. */
  name?: "gmail" | "gmail2" | "gmail3";
  connect: Connect;
  host: string;
  port: number;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string;
  /** Our name in EHLO. */
  ehloName: string;
  /** Per reply. */
  timeoutMs: number;
}

class Timeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | null = null;
  return Promise.race([
    p.finally(() => { if (t !== null) clearTimeout(t); }),
    new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Timeout(`timeout waiting for ${what}`)), ms); }),
  ]);
}

interface Reply {
  code: number;
  text: string;
}

/** Thrown for a reply we cannot continue after; `reply` is kept for the decision. */
class SmtpError extends Error {
  constructor(readonly reply: Reply, readonly step: string) {
    super(`${step}: ${reply.code} ${reply.text}`);
  }
}

class Conn {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private buf = "";
  private dec = new TextDecoder();
  private enc = new TextEncoder();
  constructor(private readonly sock: SmtpSocket, private readonly timeoutMs: number) {
    this.reader = sock.readable.getReader();
    this.writer = sock.writable.getWriter();
  }

  private async line(): Promise<string> {
    for (;;) {
      const i = this.buf.indexOf("\n");
      if (i >= 0) {
        const l = this.buf.slice(0, i).replace(/\r$/, "");
        this.buf = this.buf.slice(i + 1);
        return l;
      }
      if (this.buf.length > 4096) throw new Error("reply line too long");
      const r = await withTimeout(this.reader.read(), this.timeoutMs, "server reply");
      if (r.done) throw new Error("connection closed by server");
      this.buf += this.dec.decode(r.value, { stream: true });
    }
  }

  /** One reply, possibly multi-line ("250-..." lines then "250 ..."). */
  async reply(): Promise<Reply> {
    const texts: string[] = [];
    for (let n = 0; n < 100; n++) {
      const l = await this.line();
      const code = Number(l.slice(0, 3));
      if (!/^\d{3}([ -]|$)/.test(l)) throw new Error("malformed reply");
      texts.push(l.slice(4));
      if (l[3] !== "-") return { code, text: texts.join("\n") };
    }
    throw new Error("reply too long");
  }

  async write(s: string): Promise<void> {
    await withTimeout(this.writer.write(this.enc.encode(s)), this.timeoutMs, "write");
  }

  async cmd(line: string): Promise<Reply> {
    await this.write(line + "\r\n");
    return this.reply();
  }

  async close(): Promise<void> {
    try { this.reader.releaseLock(); } catch { /* already released */ }
    try { this.writer.releaseLock(); } catch { /* already released */ }
    await this.sock.close().catch(() => {});
  }
}

const isQuota = (r: Reply) => /\b5\.4\.5\b|daily .*limit|sending limit/i.test(r.text);
const cls = (c: number) => Math.floor(c / 100);

export class SmtpProvider implements Provider {
  readonly name: "gmail" | "gmail2" | "gmail3";
  readonly fromEmail: string;
  private conn: Conn | null = null;
  private dead: string | null = null;

  constructor(private readonly cfg: SmtpConfig) {
    this.name = cfg.name ?? "gmail";
    this.fromEmail = cfg.fromEmail;
  }

  private err(e: unknown) {
    return cleanError(e, [this.cfg.pass, b64utf8(`\u0000${this.cfg.user}\u0000${this.cfg.pass}`), b64utf8(this.cfg.pass)]);
  }

  private async open(): Promise<void> {
    const c = new Conn(this.cfg.connect(this.cfg.host, this.cfg.port), this.cfg.timeoutMs);
    this.conn = c;
    const greet = await c.reply();
    if (greet.code !== 220) throw new SmtpError(greet, "greeting");
    const ehlo = await c.cmd(`EHLO ${this.cfg.ehloName}`);
    if (ehlo.code !== 250) throw new SmtpError(ehlo, "EHLO");
    const auth = (/^AUTH[ =](.*)$/im.exec(ehlo.text)?.[1] ?? "").toUpperCase().split(/\s+/);
    if (auth.includes("PLAIN") || !auth.includes("LOGIN")) {
      const r = await c.cmd(`AUTH PLAIN ${b64utf8(`\u0000${this.cfg.user}\u0000${this.cfg.pass}`)}`);
      if (r.code !== 235) throw new SmtpError(r, "AUTH");
    } else {
      let r = await c.cmd("AUTH LOGIN");
      if (r.code === 334) r = await c.cmd(b64utf8(this.cfg.user));
      if (r.code === 334) r = await c.cmd(b64utf8(this.cfg.pass));
      if (r.code !== 235) throw new SmtpError(r, "AUTH");
    }
  }

  private async kill(): Promise<void> {
    const c = this.conn;
    this.conn = null;
    if (c) await c.close();
  }

  async send(m: Message, now: number): Promise<SendResult> {
    if (this.dead) return { status: "not_sent", error: `gmail unavailable this run: ${this.dead}`, providerDown: true };
    let afterDataEnd = false;
    try {
      if (!this.conn) await this.open();
      const c = this.conn!;
      const mail = await c.cmd(`MAIL FROM:<${this.cfg.fromEmail}>`);
      if (mail.code !== 250) throw new SmtpError(mail, "MAIL FROM");
      const rcpt = await c.cmd(`RCPT TO:<${m.to}>`);
      if (rcpt.code !== 250 && rcpt.code !== 251) {
        if (cls(rcpt.code) === 5 && !isQuota(rcpt)) {
          // This recipient is refused; the connection is still usable.
          const rs = await c.cmd("RSET");
          if (rs.code !== 250) await this.down("RSET failed");
          return { status: "rejected", error: this.err(`RCPT TO: ${rcpt.code} ${rcpt.text}`) };
        }
        throw new SmtpError(rcpt, "RCPT TO");
      }
      const data = await c.cmd("DATA");
      if (data.code !== 354) throw new SmtpError(data, "DATA");
      // From here on, a lost connection or a timeout leaves the result unknown.
      afterDataEnd = true;
      await c.write(dotStuff(buildMessage(m, now)));
      const done = await c.reply();
      if (done.code === 250) return { status: "sent" };
      if (cls(done.code) === 5 && !isQuota(done)) return { status: "rejected", error: this.err(`end of DATA: ${done.code} ${done.text}`) };
      throw new SmtpError(done, "end of DATA");
    } catch (e) {
      const error = this.err(e);
      if (e instanceof SmtpError && (e.step === "end of DATA" || !afterDataEnd)) {
        // A clear refusal: the message was not accepted.
        const quota = isQuota(e.reply);
        await this.down(error);
        return { status: "not_sent", error, providerDown: true, quotaExhausted: quota };
      }
      await this.down(error);
      if (afterDataEnd) return { status: "unknown", error };
      return { status: "not_sent", error, providerDown: true };
    }
  }

  private async down(reason: string): Promise<void> {
    this.dead = reason;
    await this.kill();
  }

  async close(): Promise<void> {
    const c = this.conn;
    if (!c) return;
    try {
      await c.cmd("QUIT");
    } catch {
      // The run is over either way.
    }
    await this.kill();
  }
}
