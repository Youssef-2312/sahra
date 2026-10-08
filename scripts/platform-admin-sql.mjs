// SQL for `node scripts/ops.mjs create-platform-admin` (no Node imports, so the
// tests run exactly this SQL against a local database).
//
// Adds a platform admin by email, or renews the sign-in window of one that has
// not signed in yet. The row has no Google account until the first sign-in with
// that address (verified Gmail, or Google Workspace with a matching domain)
// links it. Safe to run again: an active admin with the same email is never
// duplicated. The audit row is written in the same file (one transaction); the
// change log entry is written by the next request that flushes it (rev > logged_rev).

export function normalizeEmail(email) {
  const e = String(email).trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1 || e.length > 254) return null;
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) return null;
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") {
    local = local.split("+")[0].replace(/\./g, "");
    if (!local) return null;
  }
  return `${local}@${domain}`;
}

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** Returns { email, statements } or throws on bad input. `id` and `op` are random UUIDs from the caller. */
export function platformAdminSql({ name, email, id, op, now, days = 14 }) {
  const n = String(name ?? "").trim().replace(/\s+/g, " ");
  if (!n || n.length > 80) throw new Error("name: 1-80 characters");
  const e = normalizeEmail(email ?? "");
  if (!e) throw new Error("not a valid email address");
  if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f-]{36}$/.test(op)) throw new Error("bad id");
  const expires = now + days * 24 * 3600_000;
  return {
    email: e,
    statements: [
      `UPDATE platform_admins SET invite_expires_at = ${expires}, rev = rev + 1, last_op = ${q(op)}, last_action = 'admin_invite_renewed' WHERE email = ${q(e)} AND google_sub IS NULL AND disabled_at IS NULL;`,
      `INSERT INTO platform_admins (id, name, email, invite_expires_at, created_at, created_by, last_op, last_action) SELECT ${q(id)}, ${q(n)}, ${q(e)}, ${expires}, ${now}, 'operator', ${q(op)}, 'admin_created' WHERE NOT EXISTS (SELECT 1 FROM platform_admins WHERE email = ${q(e)} AND disabled_at IS NULL);`,
      `INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail) SELECT '_platform', ${now}, NULL, last_action, 'platform_admin', id, rev, 'operator script' FROM platform_admins WHERE last_op = ${q(op)};`,
    ],
  };
}
