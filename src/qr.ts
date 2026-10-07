// QR code text (section 6):
//
//   S1.<PARTY>.<K><TICKET>.<VERSION>.<SIGNATURE>
//
//   PARTY      party id, uppercased (letters, digits, dashes)
//   K          key id of the QR master secret (1-9), so the master can be rotated
//   TICKET     ticket id, 16 Crockford base32 characters (80 random bits)
//   VERSION    qr_version, decimal; reissue bumps it and older codes stop working
//   SIGNATURE  HMAC-SHA256 over everything before it, with a per-party key derived
//              by HKDF from QR_MASTER_K<K>, truncated to 26 base32 characters (130 bits)
//
// Every character is in the QR alphanumeric set (0-9, A-Z, space, $ % * + - . / :),
// so the code can use QR alphanumeric mode. The signature is checked before any
// database access.

import { MissingSecretError, base32, deriveHmacKey, hmac, isBase32, timingSafeEqualStr } from "./lib/crypto";

export interface QrPayload {
  partyId: string;
  keyId: number;
  ticketId: string;
  version: number;
}

const QR_RE = /^S1\.([A-Z0-9-]{3,24})\.([1-9])([0-9A-Z]{16})\.([1-9][0-9]{0,5})\.([0-9A-Z]{26})$/;

export function currentQrKeyId(env: Record<string, unknown>): number {
  const v = Number(env.QR_KEY_ID ?? 1);
  return Number.isInteger(v) && v >= 1 && v <= 9 ? v : 1;
}

function body(p: QrPayload): string {
  return `S1.${p.partyId.toUpperCase()}.${p.keyId}${p.ticketId}.${p.version}`;
}

export async function signQr(env: Record<string, unknown>, p: Omit<QrPayload, "keyId">): Promise<string> {
  const full: QrPayload = { ...p, keyId: currentQrKeyId(env) };
  const b = body(full);
  const key = await deriveHmacKey(env, "QR", full.partyId, full.keyId);
  return `${b}.${base32(await hmac(key, b), 26)}`;
}

/** Returns the payload only for a well-formed, correctly signed code; otherwise null. */
export async function verifyQr(env: Record<string, unknown>, text: unknown): Promise<QrPayload | null> {
  if (typeof text !== "string" || text.length > 96) return null;
  const m = QR_RE.exec(text.trim());
  if (!m) return null;
  const [, party, kid, ticketId, ver, sig] = m as unknown as [string, string, string, string, string, string];
  if (!isBase32(ticketId, 16) || !isBase32(sig, 26)) return null;
  const p: QrPayload = { partyId: party.toLowerCase(), keyId: Number(kid), ticketId, version: Number(ver) };
  let key: CryptoKey;
  try {
    key = await deriveHmacKey(env, "QR", p.partyId, p.keyId);
  } catch (e) {
    // A retired or unknown key id is just an invalid code; a missing CURRENT key is a config error.
    if (e instanceof MissingSecretError && p.keyId !== currentQrKeyId(env)) return null;
    throw e;
  }
  const expected = base32(await hmac(key, body(p)), 26);
  return timingSafeEqualStr(expected, sig) ? p : null;
}
