#!/usr/bin/env node
// Generates docs/qr-camera-test/: sample codes in the exact Sahra QR format
// (random ticket ids and random signature characters, so they are NOT valid
// tickets) to test how well phone cameras read a code shown on another phone's
// screen. Error correction level M, alphanumeric mode, as the real codes.
//   node scripts/qr-samples.mjs

import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import QRCode from "qrcode";

const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const rnd = (n) => Array.from(randomBytes(n), (b) => B32[b & 31]).join("");
const samples = [
  ["typical", `S1.CHECKPOINT-A.1${rnd(16)}.1.${rnd(26)}`],
  ["longest party id", `S1.${"HALLOWEEN-26-ARCHIVE-XY".padEnd(24, "Z")}.1${rnd(16)}.1.${rnd(26)}`],
  ["longest possible", `S1.${"A".repeat(24)}.1${rnd(16)}.999999.${rnd(26)}`],
];
const dir = "docs/qr-camera-test";
mkdirSync(dir, { recursive: true });
let md = `# QR camera test

Sample codes in the real Sahra format (QR version and size exactly as real tickets),
with random contents: they are not valid tickets. Open this page on phone A, set its
screen brightness LOW, and scan each code with phone B's camera app. Note for each:
read or not, and roughly how long it took. Also try at about 30 cm and at an angle.

| Code | Characters | QR version | Size |
|---|---|---|---|
`;
for (const [i, [label, text]] of samples.entries()) {
  const q = QRCode.create(text, { errorCorrectionLevel: "M" });
  const mode = q.segments.map((s) => s.mode.id).join("+");
  if (q.version > 4 || mode !== "Alphanumeric") throw new Error(`${label}: version ${q.version}, mode ${mode}`);
  const svg = await QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 4, color: { dark: "#000000", light: "#ffffff" } });
  writeFileSync(`${dir}/sample-${i + 1}.svg`, svg);
  md += `| ${i + 1}. ${label} | ${text.length} | ${q.version} (level M, ${mode}) | ${q.modules.size} x ${q.modules.size} |\n`;
  console.log(`${label}: ${text.length} chars, QR version ${q.version}, ${mode}`);
}
md += "\n";
for (let i = 0; i < samples.length; i++) md += `## ${i + 1}. ${samples[i][0]}\n\n<img src="sample-${i + 1}.svg" width="280" alt="sample ${i + 1}">\n\n\`${samples[i][1]}\`\n\n`;
writeFileSync(`${dir}/README.md`, md);
console.log(`Wrote ${dir}/README.md and ${samples.length} SVG codes.`);
