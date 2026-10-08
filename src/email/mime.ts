// Builds one plain-text RFC 5322 message: UTF-8 subject as RFC 2047 encoded
// words, body as quoted-printable, CRLF line endings. No HTML, no tracking, no
// List-Unsubscribe (transactional messages only).

const enc = new TextEncoder();

export interface Message {
  /** The outbox row id; also the Message-ID, so a retried duplicate has the same id. */
  id: string;
  fromEmail: string;
  fromName: string;
  to: string;
  subject: string;
  text: string;
}

/** Strict enough for a header and an SMTP path: no spaces, angle brackets, quotes or control characters. */
export function isSafeAddress(s: string): boolean {
  return s.length <= 254 && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/.test(s);
}

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

/** "AUTH PLAIN" and "AUTH LOGIN" arguments (UTF-8, then base64). */
export function b64utf8(s: string): string {
  return b64(enc.encode(s));
}

/**
 * A header value: as is when it is printable ASCII, otherwise RFC 2047 "B"
 * encoded words of at most 75 characters each, folded onto continuation lines.
 * Never splits a UTF-8 character across two words.
 */
export function encodeHeader(value: string): string {
  const v = value.replace(/[\r\n\t]+/g, " ");
  if (/^[\x20-\x7e]*$/.test(v) && v.length <= 900) return v;
  const words: string[] = [];
  let chunk: number[] = [];
  // 75 - "=?UTF-8?B?".length - "?=".length = 63 base64 chars -> at most 45 bytes per word.
  for (const ch of v) {
    const bytes = enc.encode(ch);
    if (chunk.length + bytes.length > 45) {
      words.push(`=?UTF-8?B?${b64(new Uint8Array(chunk))}?=`);
      chunk = [];
    }
    chunk.push(...bytes);
  }
  if (chunk.length) words.push(`=?UTF-8?B?${b64(new Uint8Array(chunk))}?=`);
  return words.join("\r\n ");
}

/** Quoted-printable (RFC 2045): lines of at most 76 characters, CRLF endings, soft breaks with "=". */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const bytes = enc.encode(line);
    let cur = "";
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      const last = i === bytes.length - 1;
      let t: string;
      if ((b === 0x20 || b === 0x09) && !last) t = String.fromCharCode(b);
      else if (b >= 33 && b <= 126 && b !== 61) t = String.fromCharCode(b);
      else t = "=" + b.toString(16).toUpperCase().padStart(2, "0");
      if (cur.length + t.length > 75) {
        out.push(cur + "=");
        cur = "";
      }
      cur += t;
    }
    out.push(cur);
  }
  return out.join("\r\n");
}

/** RFC 5322 date, e.g. "Wed, 07 Oct 2026 18:00:00 +0000". */
export function rfc5322Date(ms: number): string {
  return new Date(ms).toUTCString().replace(/GMT$/, "+0000");
}

/** The full message (headers, blank line, body), CRLF line endings, not yet dot-stuffed. */
export function buildMessage(m: Message, now: number): string {
  const domain = m.fromEmail.split("@")[1] ?? "localhost";
  const headers = [
    `From: ${encodeHeader(m.fromName)} <${m.fromEmail}>`,
    `To: <${m.to}>`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: <${m.id}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: quoted-printable",
  ];
  return headers.join("\r\n") + "\r\n\r\n" + quotedPrintable(m.text);
}

/** SMTP DATA payload: dot-stuffed lines, ended by CRLF "." CRLF. */
export function dotStuff(message: string): string {
  return message.split("\r\n").map((l) => (l.startsWith(".") ? "." + l : l)).join("\r\n") + "\r\n.\r\n";
}
