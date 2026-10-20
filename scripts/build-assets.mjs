#!/usr/bin/env node
// Builds the static site that is deployed (wrangler.jsonc "build" runs this before
// `wrangler deploy` and `wrangler dev`; the assets directory is dist/public).
//
// - public/ is copied to dist/public unchanged in meaning.
// - Every script and stylesheet is minified (whitespace and comments removed,
//   local names shortened). Top-level names stay, because the pages' scripts
//   share globals (Sahra, SahraText, SahraStaff...). This makes the code harder
//   to read; it does not hide anything: never put secrets in browser code.
// - Each script, stylesheet and font also gets a versioned copy under
//   /v/<content hash>/..., and the pages load those. public/_headers lets browsers
//   keep /v/ files for a year (a new version has a new address), so repeat visits
//   load them from the browser without asking the server. The unversioned files
//   stay for anything else that names them (the Worker's own pages, jsQR).
// - Pages preload the main Latin font so text appears in it sooner.
//
// Usage: node scripts/build-assets.mjs        (writes dist/public)
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "public");
const out = join(root, "dist", "public");
const PRELOAD_FONT = "/fonts/archivo-latin-variable.woff2";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const hash = (buf) => createHash("sha256").update(buf).digest("hex").slice(0, 12);
const url = (file) => "/" + relative(out, file).split("\\").join("/");

rmSync(join(root, "dist"), { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true });

let before = 0, after = 0;
const versioned = new Map(); // "/js/ui.js" -> "/v/<hash>/js/ui.js"
function version(file, body) {
  const path = url(file);
  const v = `/v/${hash(body)}${path}`;
  const dest = join(out, v);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  versioned.set(path, v);
}

// Fonts first (stylesheets name them).
for (const f of walk(join(out, "fonts")).filter((f) => f.endsWith(".woff2"))) version(f, readFileSync(f));

for (const f of walk(out)) {
  if (f.includes(`${join(out, "v")}`) || f.includes(join(out, "vendor"))) continue;
  const isJs = f.endsWith(".js"), isCss = f.endsWith(".css");
  if (!isJs && !isCss) continue;
  const code = readFileSync(f, "utf8");
  before += Buffer.byteLength(code);
  let min = transformSync(code, { loader: isJs ? "js" : "css", minify: true, legalComments: "none", charset: "utf8", ...(isJs ? { target: "es2019" } : {}) }).code;
  if (isCss) min = min.replace(/url\((["']?)(\/fonts\/[^"')]+)\1\)/g, (m, q, p) => (versioned.has(p) ? `url(${q}${versioned.get(p)}${q})` : m));
  after += Buffer.byteLength(min);
  writeFileSync(f, min);
  version(f, min);
}

// Pages: load the versioned scripts and stylesheets, and preload the main font.
let pages = 0;
for (const f of walk(out).filter((f) => f.endsWith(".html") && !f.includes(`${join(out, "v")}`))) {
  let html = readFileSync(f, "utf8");
  html = html.replace(/(<script\b[^>]*\bsrc=")(\/js\/[^"?#]+)(")/g, (m, a, p, b) => (versioned.has(p) ? a + versioned.get(p) + b : m));
  html = html.replace(/(<link\b[^>]*\bhref=")(\/css\/[^"?#]+)(")/g, (m, a, p, b) => (versioned.has(p) ? a + versioned.get(p) + b : m));
  if (versioned.has(PRELOAD_FONT) && /<link rel="stylesheet" href="\/v\//.test(html) && !html.includes('rel="preload"')) {
    html = html.replace(/<link rel="stylesheet"/, `<link rel="preload" href="${versioned.get(PRELOAD_FONT)}" as="font" type="font/woff2" crossorigin>\n<link rel="stylesheet"`);
  }
  writeFileSync(f, html);
  pages++;
}

// Browsers may keep versioned files for a year: their address changes with their content.
const headers = join(out, "_headers");
writeFileSync(headers, readFileSync(headers, "utf8").trimEnd() + "\n\n# Versioned copies (scripts/build-assets.mjs): the address changes with the content.\n/v/*\n  Cache-Control: public, max-age=31536000, immutable\n");

if (!existsSync(join(out, "index.html"))) throw new Error("build output is missing index.html");
console.log(`Built dist/public: ${pages} pages, ${versioned.size} versioned files, scripts and styles ${Math.round(before / 1024)} kB -> ${Math.round(after / 1024)} kB before compression.`);
