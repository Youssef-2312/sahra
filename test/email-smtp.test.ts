// SMTP client and message format, against a fake socket (no network).
import { describe, expect, it } from "vitest";
import { buildMessage, dotStuff, encodeHeader, isSafeAddress, quotedPrintable, type Message } from "../src/email/mime";
import { SmtpProvider } from "../src/email/smtp";
import { FakeSmtp } from "./fake-smtp";

const PASS = "test-only-app-password";

function provider(f: FakeSmtp, timeoutMs = 200) {
  return new SmtpProvider({
    connect: f.connect, host: "smtp.fake", port: 465, user: "platform@gmail.com", pass: PASS,
    fromEmail: "platform@gmail.com", fromName: "Sahra", ehloName: "sahra.test", timeoutMs,
  });
}

const msg = (over: Partial<Message> = {}): Message => ({
  id: "0b6c7f0e-1111-4222-8333-444455556666", fromEmail: "platform@gmail.com", fromName: "Sahra",
  to: "guest@example.com", subject: "Your ticket", text: "Hello\n.dot line\nBye", ...over,
});

function decodeQP(s: string) {
  const bytes: number[] = [];
  const t = s.replace(/=\r\n/g, "");
  for (let i = 0; i < t.length; i++) {
    if (t[i] === "=") { bytes.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; } else bytes.push(t.charCodeAt(i));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

describe("message format", () => {
  it("encodes a non-ASCII subject as RFC 2047 words of at most 75 characters, without splitting characters", () => {
    const subject = "تذكرتك للحفلة جاهزة - Votre billet est prêt pour la soirée de ce soir";
    const h = encodeHeader(subject);
    const words = h.split("\r\n ");
    for (const w of words) {
      expect(w).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
      expect(w.length).toBeLessThanOrEqual(75);
    }
    const decoded = words.map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (c) => c.charCodeAt(0)))).join("");
    expect(decoded).toBe(subject);
    expect(encodeHeader("Plain ASCII")).toBe("Plain ASCII");
    expect(encodeHeader("Bcc: x\r\nInjected: yes")).not.toMatch(/\r\n(?! )/);
  });

  it("quoted-printable: lines of at most 76, CRLF, round trip", () => {
    const text = "Line with = sign and trailing space \nأهلا بك في الحفلة ".repeat(5) + "\n" + "x".repeat(200);
    const qp = quotedPrintable(text);
    for (const l of qp.split("\r\n")) {
      expect(l.length).toBeLessThanOrEqual(76);
      expect(l).not.toMatch(/[ \t]$/);
    }
    expect(decodeQP(qp)).toBe(text.replace(/\r\n?/g, "\n").split("\n").join("\r\n"));
  });

  it("builds headers and dot-stuffs the body", () => {
    const raw = buildMessage(msg(), Date.UTC(2026, 9, 7, 18, 0, 0));
    expect(raw).toContain("From: Sahra <platform@gmail.com>\r\n");
    expect(raw).toContain("To: <guest@example.com>\r\n");
    expect(raw).toContain("Date: Wed, 07 Oct 2026 18:00:00 +0000\r\n");
    expect(raw).toContain("Message-ID: <0b6c7f0e-1111-4222-8333-444455556666@gmail.com>\r\n");
    expect(raw).toContain("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n");
    expect(raw).not.toMatch(/List-Unsubscribe/i);
    expect(raw).not.toMatch(/[^\r]\n/);
    const stuffed = dotStuff(raw);
    expect(stuffed).toContain("\r\n..dot line\r\n");
    expect(stuffed.endsWith("\r\nBye\r\n.\r\n")).toBe(true);
  });

  it("accepts only safe addresses", () => {
    expect(isSafeAddress("guest+party@example.co.uk")).toBe(true);
    for (const bad of ["a@b", "a b@c.com", "<a@b.com>", "a@b.com\r\nRCPT TO:<x@y.com>", "a@-b.com", "\"q\"@b.com"]) {
      expect(isSafeAddress(bad), bad).toBe(false);
    }
  });
});

describe("SMTP client", () => {
  it("EHLO, AUTH PLAIN, MAIL, RCPT, DATA for two messages on one connection, then QUIT", async () => {
    const f = new FakeSmtp();
    const p = provider(f);
    expect(await p.send(msg(), 1000)).toEqual({ status: "sent" });
    expect(await p.send(msg({ to: "second@example.com" }), 1000)).toEqual({ status: "sent" });
    await p.close();
    expect(f.connections).toBe(1);
    expect(f.commands[0]).toBe("EHLO sahra.test");
    expect(f.commands[1]).toBe(`AUTH PLAIN ${btoa(`\0platform@gmail.com\0${PASS}`)}`);
    expect(f.commands.slice(2, 5)).toEqual(["MAIL FROM:<platform@gmail.com>", "RCPT TO:<guest@example.com>", "DATA"]);
    expect(f.commands.at(-1)).toBe("QUIT");
    expect(f.messages.map((m) => m.to)).toEqual([["<guest@example.com>"], ["<second@example.com>"]]);
    expect(f.messages[0]!.data).toContain("..dot line");
  });

  it("uses AUTH LOGIN when PLAIN is not offered", async () => {
    const f = new FakeSmtp();
    f.authMechs = "LOGIN";
    const p = provider(f);
    expect(await p.send(msg(), 1000)).toEqual({ status: "sent" });
    expect(f.commands.slice(1, 4)).toEqual(["AUTH LOGIN", btoa("platform@gmail.com"), btoa(PASS)]);
  });

  it("login refused: not sent, provider down for the run, password never in the error", async () => {
    const f = new FakeSmtp();
    f.authOk = false;
    const p = provider(f);
    const r = await p.send(msg(), 1000);
    expect(r).toMatchObject({ status: "not_sent", providerDown: true });
    expect(JSON.stringify(r)).not.toContain(PASS);
    expect(JSON.stringify(r)).not.toContain(btoa(`\0platform@gmail.com\0${PASS}`));
    expect(await p.send(msg(), 1000)).toMatchObject({ status: "not_sent" });
    expect(f.connections).toBe(1);
  });

  it("a refused recipient is rejected; the connection is reset and reused", async () => {
    const f = new FakeSmtp();
    f.rcptReply = (to) => (to.includes("nobody") ? "550 5.1.1 The email account that you tried to reach does not exist" : "250 OK");
    const p = provider(f);
    expect(await p.send(msg({ to: "nobody@example.com" }), 1000)).toMatchObject({ status: "rejected" });
    expect(await p.send(msg(), 1000)).toEqual({ status: "sent" });
    expect(f.commands).toContain("RSET");
    expect(f.connections).toBe(1);
  });

  it("connection lost or no reply after the end of DATA: unknown", async () => {
    const f = new FakeSmtp();
    f.dataEnd = () => "drop";
    expect(await provider(f).send(msg(), 1000)).toMatchObject({ status: "unknown" });
    const g = new FakeSmtp();
    g.dataEnd = () => "hang";
    expect(await provider(g, 50).send(msg(), 1000)).toMatchObject({ status: "unknown", error: expect.stringMatching(/timeout/) });
  });

  it("no greeting (timeout before DATA): not sent", async () => {
    const f = new FakeSmtp();
    f.delayMs = 500;
    expect(await provider(f, 50).send(msg(), 1000)).toMatchObject({ status: "not_sent", providerDown: true });
  });

  it("a temporary refusal at the end of DATA is not sent; Gmail's daily limit marks the quota", async () => {
    const f = new FakeSmtp();
    f.dataEnd = () => "451 4.3.0 Temporary failure";
    expect(await provider(f).send(msg(), 1000)).toMatchObject({ status: "not_sent" });
    const g = new FakeSmtp();
    g.mailReply = "550 5.4.5 Daily user sending limit exceeded";
    expect(await provider(g).send(msg(), 1000)).toMatchObject({ status: "not_sent", quotaExhausted: true });
  });
});
