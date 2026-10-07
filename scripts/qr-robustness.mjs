#!/usr/bin/env node
// Simulated "a phone camera reads a code shown on another phone's screen" test,
// run in software instead of with two phones. Real-format codes (QR version 4,
// level M, alphanumeric) are rendered at phone-screen size, degraded the way a
// dim screen and a hand-held camera degrade them, and decoded by two standard
// decoders: jsQR and ZXing (the engine behind many Android scanners). A code
// passes only if the exact original text comes back.
//
// Each condition is tried three ways:
//   as is     - the frame straight to the decoder;
//   stretch   - per-frame contrast stretch (2nd..98th brightness percentile to 0..255);
//   avg4      - average of 4 noisy frames, then stretch (a scanner sees 10-30 frames/s).
// This is not identical to real cameras (autofocus, glare, moire) and phone
// camera apps use stronger decoders, so it is a conservative check.
//   node scripts/qr-robustness.mjs

import { randomBytes } from "node:crypto";
import Z from "@zxing/library";
import jsQR from "jsqr";
import QRCode from "qrcode";
import sharp from "sharp";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const rnd = (n) => Array.from(randomBytes(n), (b) => B32[b & 31]).join("");
const newCode = (i) => (i % 2 === 0 ? `S1.CHECKPOINT-A.1${rnd(16)}.1.${rnd(26)}` : `S1.${"A".repeat(24)}.1${rnd(16)}.999999.${rnd(26)}`);
const TRIALS = 10;

// dark/light: brightness of dark modules and background (0-255); a dim phone
// screen photographed by another phone is roughly 90 vs 150.
const conditions = [
  ["clean", { px: 300 }],
  ["dim screen 90/150", { px: 300, dark: 90, light: 150 }],
  ["very dim 110/150", { px: 300, dark: 110, light: 150 }],
  ["extremely dim 125/150", { px: 300, dark: 125, light: 150 }],
  ["blur 1.5", { px: 300, blur: 1.5 }],
  ["blur 3", { px: 300, blur: 3 }],
  ["camera noise 40", { px: 300, noise: 40 }],
  ["rotated 25 degrees", { px: 300, rotate: 25 }],
  ["camera at an angle (skew)", { px: 300, skew: 0.25 }],
  ["tiny (80 px wide)", { px: 80 }],
  ["dim + noise", { px: 300, dark: 90, light: 150, noise: 30 }],
  ["dim+blur+noise+rotate+skew, small", { px: 220, dark: 90, light: 150, blur: 1.5, noise: 30, rotate: 15, skew: 0.15 }],
];

async function base(text, c) {
  const svg = await QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 4 });
  let img = sharp(Buffer.from(svg)).resize(c.px, c.px, { kernel: "nearest" }).flatten({ background: "#ffffff" }).greyscale();
  if (c.dark !== undefined) img = img.linear((c.light - c.dark) / 255, c.dark);
  if (c.skew) img = img.affine([[1, c.skew], [0, 1]], { background: { r: 255, g: 255, b: 255 } });
  if (c.rotate) img = img.rotate(c.rotate, { background: { r: 255, g: 255, b: 255 } });
  if (c.blur) img = img.blur(c.blur);
  // Place on a grey surround, like the rest of a camera frame.
  img = sharp(await img.png().toBuffer()).extend({ top: 60, bottom: 60, left: 60, right: 60, background: { r: 140, g: 140, b: 140 } });
  const { data, info } = await img.greyscale().raw().toBuffer({ resolveWithObject: true });
  return { g: data, w: info.width, h: info.height };
}
const noisy = (g, n) => Float32Array.from(g, (v) => v + (n ? (Math.random() - 0.5) * 2 * n : 0));
const clamp = (f) => Uint8Array.from(f, (v) => Math.max(0, Math.min(255, v)));
function stretch(f) {
  const s = Float32Array.from(f).sort();
  const lo = s[Math.floor(s.length * 0.02)], hi = s[Math.floor(s.length * 0.98)], span = Math.max(1, hi - lo);
  return Uint8Array.from(f, (v) => Math.max(0, Math.min(255, ((v - lo) * 255) / span)));
}
function decodeBoth(g, w, h, code) {
  const rgba = new Uint8ClampedArray(g.length * 4);
  for (let i = 0; i < g.length; i++) { rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = g[i]; rgba[i * 4 + 3] = 255; }
  const j = jsQR(rgba, w, h, { inversionAttempts: "dontInvert" })?.data === code;
  let z = false;
  try {
    const src = new Z.RGBLuminanceSource(Uint8ClampedArray.from(g), w, h);
    z = new Z.QRCodeReader().decode(new Z.BinaryBitmap(new Z.HybridBinarizer(src)), new Map([[Z.DecodeHintType.TRY_HARDER, true]])).getText() === code;
  } catch { /* not found */ }
  return { j, z };
}

console.log(`${"condition".padEnd(36)} ${"as is".padEnd(12)} ${"stretch".padEnd(12)} avg4+stretch   (jsQR/ZXing, of ${TRIALS} each)`);
for (const [name, c] of conditions) {
  const n = { raw: [0, 0], st: [0, 0], avg: [0, 0] };
  for (let t = 0; t < TRIALS; t++) {
    const code = newCode(t);
    const { g, w, h } = await base(code, c);
    const one = noisy(g, c.noise);
    const add = (k, r) => { if (r.j) n[k][0]++; if (r.z) n[k][1]++; };
    add("raw", decodeBoth(clamp(one), w, h, code));
    add("st", decodeBoth(stretch(one), w, h, code));
    const acc = new Float32Array(g.length);
    for (let f = 0; f < 4; f++) { const x = noisy(g, c.noise); for (let i = 0; i < acc.length; i++) acc[i] += x[i] / 4; }
    add("avg", decodeBoth(stretch(acc), w, h, code));
  }
  const f = ([a, b]) => `${a}/${b}`.padEnd(12);
  console.log(`${name.padEnd(36)} ${f(n.raw)} ${f(n.st)} ${f(n.avg)}`);
}
console.log("\nFormat: QR version 4, level M, one alphanumeric segment (typical and longest possible codes).");
