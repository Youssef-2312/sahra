// A scripted SMTP server behind a fake socket, and a fake Brevo API. No network.
import type { Connect, SmtpSocket } from "../src/email/smtp";

export interface Received {
  from: string;
  to: string[];
  data: string;
}

type DataEnd = "ok" | "drop" | "hang" | string;

export class FakeSmtp {
  connections = 0;
  commands: string[] = [];
  messages: Received[] = [];
  greeting = "220 smtp.fake ESMTP ready";
  authMechs = "LOGIN PLAIN XOAUTH2";
  authOk = true;
  mailReply = "250 2.1.0 OK";
  rcptReply: (to: string) => string = () => "250 2.1.5 OK";
  /** Reply after the end of DATA: "ok", "drop" (close without a reply), "hang" (never reply) or a reply line. */
  dataEnd: (n: number) => DataEnd = () => "ok";
  /** Delay (ms) before each reply, to let concurrent runs interleave. */
  delayMs = 0;
  closed = 0;

  connect: Connect = () => {
    this.connections++;
    const enc = new TextEncoder(), dec = new TextDecoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let open = true;
    const readable = new ReadableStream<Uint8Array>({ start: (c) => { ctrl = c; } });
    const send = async (line: string) => {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      if (open) ctrl.enqueue(enc.encode(line + "\r\n"));
    };
    const drop = () => { if (open) { open = false; ctrl.close(); } };
    let buf = "", inData = false, cur: Received = { from: "", to: [], data: "" };
    const onLine = async (l: string) => {
      this.commands.push(l);
      const up = l.toUpperCase();
      if (up.startsWith("EHLO")) return send(`250-smtp.fake\r\n250-SIZE 35882577\r\n250-AUTH ${this.authMechs}\r\n250 SMTPUTF8`);
      if (up.startsWith("AUTH PLAIN")) return send(this.authOk ? "235 2.7.0 Accepted" : "535 5.7.8 Username and Password not accepted");
      if (up === "AUTH LOGIN") return send("334 VXNlcm5hbWU6");
      if (up.startsWith("MAIL FROM:")) { cur = { from: l.slice(10), to: [], data: "" }; return send(this.mailReply); }
      if (up.startsWith("RCPT TO:")) {
        const r = this.rcptReply(l.slice(8));
        if (r.startsWith("25")) cur.to.push(l.slice(8));
        return send(r);
      }
      if (up === "DATA") { inData = true; return send("354 Go ahead"); }
      if (up === "RSET") return send("250 2.1.5 Flushed");
      if (up === "QUIT") { await send("221 2.0.0 closing"); return drop(); }
      if (this.commands.at(-2) === "AUTH LOGIN") return send("334 UGFzc3dvcmQ6");
      if (this.commands.at(-3) === "AUTH LOGIN") return send(this.authOk ? "235 2.7.0 Accepted" : "535 5.7.8 not accepted");
      return send("502 5.5.1 Unrecognized command");
    };
    const pump = async () => {
      for (;;) {
        if (inData) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          cur.data = buf.slice(0, end + 2);
          buf = buf.slice(end + 5);
          inData = false;
          this.messages.push(cur);
          const r = this.dataEnd(this.messages.length);
          if (r === "drop") return drop();
          if (r === "hang") continue;
          await send(r === "ok" ? "250 2.0.0 OK queued" : r);
          continue;
        }
        const i = buf.indexOf("\r\n");
        if (i < 0) return;
        const l = buf.slice(0, i);
        buf = buf.slice(i + 2);
        await onLine(l);
      }
    };
    let chain = Promise.resolve();
    const writable = new WritableStream<Uint8Array>({
      write: (chunk) => {
        if (!open) throw new Error("connection closed");
        buf += dec.decode(chunk, { stream: true });
        chain = chain.then(pump);
      },
    });
    void send(this.greeting);
    const sock: SmtpSocket = { readable, writable, close: async () => { this.closed++; drop(); } };
    return sock;
  };
}

export class FakeBrevo {
  requests: { url: string; headers: Headers; body: Record<string, unknown> }[] = [];
  reply: (n: number) => Response | "throw" = () => Response.json({ messageId: "<x@brevo>" }, { status: 201 });
  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    this.requests.push({ url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
    const r = this.reply(this.requests.length);
    if (r === "throw") throw new Error("network connection lost");
    return r;
  };
}
