#!/usr/bin/env node
// Prints a fresh 256-bit secret (base64url) for QR_MASTER_K1 / LINK_MASTER_K1.
// Pipe it straight into Cloudflare so it never appears on screen or in chat:
//   node scripts/gen-secret.mjs | npx wrangler secret put QR_MASTER_K1
import { randomBytes } from "node:crypto";
process.stdout.write(randomBytes(32).toString("base64url"));
