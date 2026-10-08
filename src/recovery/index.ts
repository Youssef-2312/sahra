// Controlled recovery procedure (brief section 8.3). The same code runs in the
// tests (workerd, D1 bindings) and in the owner's recovery script
// (scripts/recover.mjs, through `wrangler d1 execute` with the owner's own
// Cloudflare login). No Worker can restore the database; only the owner's
// credential can.
//
//   1. pauseAll        every party's control object: paused, pause_number + 1
//   2. flushAll        copy every committed change and admission not yet in the
//                      ledger into the ledger (main database reachable)
//      verify          every row's current rev is in the ledger with the same state
//      holdsFromIntents  when the main database is unreachable or does not match:
//                      every entity with an unconfirmed intent is held
//   3. (restore)       Time Travel, done by the owner's script
//   4. replay          newest rev per entity wins (an older entry never overwrites
//                      a newer state); a restored row newer than the ledger is held
//   5. applyHolds      held tickets cannot be admitted, held staff are disabled,
//                      until an owner resolves each one (audit)
//      revokeAccess    every session and every unused invitation
//   6. syncPause       the database's pause_number matches the control object;
//                      parties stay paused until an owner or admin reopens them
//
// Every step is idempotent: the script can be stopped and run again.
//
// Driver use: reads go through `all()`, writes through `batch()` with writes only,
// so the wrangler driver can send reads as commands and writes as one file.

import type { SqlDriver } from "../db/driver";
import { sql, raw, type Sql } from "../db/sql";

export type Entity = "party" | "staff" | "invite" | "ticket" | "platform_admin" | "organiser" | "organiser_invite";

/** Logged tables, parents before children (foreign keys). */
export const ENTITY_TABLES: readonly { entity: Entity; table: string }[] = [
  { entity: "platform_admin", table: "platform_admins" },
  { entity: "organiser", table: "organisers" },
  { entity: "organiser_invite", table: "organiser_invites" },
  { entity: "party", table: "parties" },
  { entity: "staff", table: "staff" },
  { entity: "invite", table: "invites" },
  { entity: "ticket", table: "tickets" },
];

/** Site-level rows (site owners, organisers) belong to no party; the change log files them under this id. */
export const PLATFORM = "_platform";
const PLATFORM_ENTITIES: ReadonlySet<Entity> = new Set(["platform_admin", "organiser", "organiser_invite"]);

/** Entities recovery can hold: tickets (not admitted), staff, parties, organisers and site owners (disabled). */
const HOLDABLE: ReadonlySet<string> = new Set(["ticket", "staff", "party", "organiser", "platform_admin"]);

type Row = Record<string, unknown>;

export interface EntityKey {
  entity: Entity;
  id: string;
}

export interface Hold extends EntityKey {
  party_id: string;
  reason: string;
}

const PAGE = 1000;

/**
 * All rows of a table, paged by `key` (no OFFSET scans). If `key` is not unique
 * (intents: op_id), the rows sharing the last key of a full page are re-read in
 * full, so no row is skipped at a page boundary.
 */
async function allRows(d: SqlDriver, table: string, key = "id", unique = true): Promise<Row[]> {
  const out: Row[] = [];
  let after: string | null = null;
  for (;;) {
    const q: Sql = after === null
      ? sql`SELECT * FROM ${raw(table)} ORDER BY ${raw(key)} LIMIT ${PAGE}`
      : sql`SELECT * FROM ${raw(table)} WHERE ${raw(key)} > ${after} ORDER BY ${raw(key)} LIMIT ${PAGE}`;
    const r = await d.all<Row>(q);
    if (r.results.length < PAGE) {
      out.push(...r.results);
      return out;
    }
    after = String(r.results[r.results.length - 1]![key]);
    if (unique) {
      out.push(...r.results);
    } else {
      out.push(...r.results.filter((x) => String(x[key]) !== after));
      out.push(...(await d.all<Row>(sql`SELECT * FROM ${raw(table)} WHERE ${raw(key)} = ${after}`)).results);
    }
  }
}

function stateOf(row: Row): Row {
  const { logged_rev: _ignored, ...state } = row;
  return state;
}

/** Same state: every column of the row equals the entry's value (a column added after the entry counts as NULL there). */
export function sameState(row: Row, state: Row): boolean {
  for (const [k, v] of Object.entries(row)) {
    if (k === "logged_rev") continue;
    const s = k in state ? state[k] : null;
    if ((v ?? null) !== (s ?? null)) return false;
  }
  return true;
}

function partyOf(entity: Entity, row: Row): string {
  if (PLATFORM_ENTITIES.has(entity)) return PLATFORM;
  return String(entity === "party" ? row.id : row.party_id);
}

// ------------------------------------------------------------------ ledger reads

export interface LedgerEntry {
  event_id: string;
  party_id: string;
  entity: string;
  entity_id: string;
  rev: number;
  action: string | null;
  state: Row;
}

export async function ledgerEntries(ledger: SqlDriver): Promise<LedgerEntry[]> {
  const rows = await allRows(ledger, "change_log", "event_id");
  return rows.map((r) => ({
    event_id: String(r.event_id), party_id: String(r.party_id), entity: String(r.entity), entity_id: String(r.entity_id),
    rev: Number(r.rev), action: r.action == null ? null : String(r.action), state: JSON.parse(String(r.state)) as Row,
  }));
}

/** Newest entry per entity (the replay rule: newest rev wins). */
export function newestByEntity(entries: LedgerEntry[]): Map<string, LedgerEntry> {
  const m = new Map<string, LedgerEntry>();
  for (const e of entries) {
    const k = `${e.entity}:${e.entity_id}`;
    const cur = m.get(k);
    if (!cur || e.rev > cur.rev) m.set(k, e);
  }
  return m;
}

// ------------------------------------------------------------------ step 1

/** Pauses every party with a control object (paused, pause_number + 1). Returns the parties paused by this call. */
export async function pauseAll(ledger: SqlDriver, now: number, by: string): Promise<string[]> {
  const controls = (await ledger.all<{ party_id: string; state: string; pause_number: number; rev: number }>(
    sql`SELECT party_id, state, pause_number, rev FROM party_control`)).results;
  const open = controls.filter((c) => c.state !== "paused");
  if (open.length) {
    await ledger.batch(open.map((c) => sql`UPDATE party_control SET state = 'paused', pause_number = ${c.pause_number + 1},
      rev = rev + 1, updated_at = ${now}, updated_by = ${by} WHERE party_id = ${c.party_id} AND rev = ${c.rev}`));
  }
  // Conditional writes: confirm by reading back (a concurrent change would need another run).
  const after = (await ledger.all<{ party_id: string; state: string }>(sql`SELECT party_id, state FROM party_control`)).results;
  const still = after.filter((c) => c.state !== "paused");
  if (still.length) throw new Error(`could not pause: ${still.map((c) => c.party_id).join(", ")}; run again`);
  return open.map((c) => c.party_id);
}

// ------------------------------------------------------------------ step 2

/**
 * Copies every row whose current rev has no ledger entry into the ledger (full
 * state, entity + rev, idempotent), then marks it logged. Includes admissions
 * whose record never reached the ledger: the ticket is then recorded as used.
 */
export async function flushAll(main: SqlDriver, ledger: SqlDriver, now: number): Promise<number> {
  const have = new Set((await allRows(ledger, "change_log", "event_id")).map((r) => String(r.event_id)));
  let written = 0;
  for (const { entity, table } of ENTITY_TABLES) {
    const rows = await allRows(main, table);
    const missing = rows.filter((r) => !have.has(`${entity}:${r.id}:${r.rev}`));
    for (let i = 0; i < missing.length; i += 50) {
      const chunk = missing.slice(i, i + 50);
      await ledger.batch(chunk.map((r) => sql`INSERT INTO change_log (event_id, party_id, entity, entity_id, rev, action, logged_at, state)
        VALUES (${`${entity}:${r.id}:${r.rev}`}, ${partyOf(entity, r)}, ${entity}, ${String(r.id)}, ${Number(r.rev)},
          ${r.last_action == null ? null : String(r.last_action)}, ${now}, ${JSON.stringify(stateOf(r))})
        ON CONFLICT (event_id) DO NOTHING`));
      await main.batch(chunk.map((r) => sql`UPDATE ${raw(table)} SET logged_rev = ${Number(r.rev)}
        WHERE id = ${String(r.id)} AND logged_rev < ${Number(r.rev)} AND rev = ${Number(r.rev)}`));
      written += chunk.length;
    }
  }
  return written;
}

export interface VerifyResult {
  ok: boolean;
  rows: number;
  /** Rows whose current rev is missing from the ledger, or whose ledger state differs. */
  mismatches: (EntityKey & { party_id: string; problem: "missing" | "different" })[];
}

/** Every row's current rev is in the ledger with the same state. */
export async function verify(main: SqlDriver, ledger: SqlDriver): Promise<VerifyResult> {
  const byEvent = new Map((await ledgerEntries(ledger)).map((e) => [e.event_id, e]));
  const mismatches: VerifyResult["mismatches"] = [];
  let n = 0;
  for (const { entity, table } of ENTITY_TABLES) {
    for (const r of await allRows(main, table)) {
      n++;
      const e = byEvent.get(`${entity}:${r.id}:${r.rev}`);
      if (!e) mismatches.push({ entity, id: String(r.id), party_id: partyOf(entity, r), problem: "missing" });
      else if (!sameState(r, e.state)) mismatches.push({ entity, id: String(r.id), party_id: partyOf(entity, r), problem: "different" });
    }
  }
  return { ok: mismatches.length === 0, rows: n, mismatches };
}

/**
 * The main database could not be checked: every entity with an intent that no
 * ledger entry confirms (state.last_op = the intent's op id) may have changed
 * without a record. Those are held.
 */
export async function holdsFromIntents(ledger: SqlDriver): Promise<Hold[]> {
  const intents = await allRows(ledger, "intents", "op_id", false);
  const confirmed = new Set<string>();
  for (const e of await ledgerEntries(ledger)) {
    if (typeof e.state.last_op === "string") confirmed.add(`${e.state.last_op}|${e.entity}|${e.entity_id}`);
  }
  const holds = new Map<string, Hold>();
  for (const i of intents) {
    const k = `${i.op_id}|${i.entity}|${i.entity_id}`;
    if (confirmed.has(k)) continue;
    const entity = String(i.entity) as Entity;
    if (!HOLDABLE.has(entity)) continue;
    holds.set(`${entity}:${i.entity_id}`, {
      entity, id: String(i.entity_id), party_id: String(i.party_id), reason: `unconfirmed ${String(i.action)} (${String(i.op_id)})`,
    });
  }
  return [...holds.values()];
}

// ------------------------------------------------------------------ step 4

export interface ReplayResult {
  applied: number;
  unchanged: number;
  /** Restored rows newer than (or different from) the ledger's newest entry. */
  holds: Hold[];
}

async function columnsOf(main: SqlDriver, table: string): Promise<Set<string>> {
  const r = await main.all<{ name: string }>(sql`SELECT name FROM pragma_table_info(${table})`);
  return new Set(r.results.map((c) => c.name));
}

function literalSafe(name: string) {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`unexpected column name ${name}`);
  return name;
}

/**
 * Replay rule (section 8.2): for every entity, the ledger's newest entry is
 * applied only if its rev is newer than the database's (or the row is missing).
 * An older entry never overwrites a newer state.
 */
export async function replay(main: SqlDriver, ledger: SqlDriver): Promise<ReplayResult> {
  const newest = newestByEntity(await ledgerEntries(ledger));
  const res: ReplayResult = { applied: 0, unchanged: 0, holds: [] };
  for (const { entity, table } of ENTITY_TABLES) {
    const cols = await columnsOf(main, table);
    const rows = new Map((await allRows(main, table)).map((r) => [String(r.id), r]));
    const writes: Sql[] = [];
    for (const e of newest.values()) {
      if (e.entity !== entity) continue;
      const row = rows.get(e.entity_id);
      if (row && Number(row.rev) > e.rev) {
        res.holds.push({ entity, id: e.entity_id, party_id: e.party_id, reason: `database rev ${row.rev} newer than the change log (${e.rev})` });
        continue;
      }
      if (row && Number(row.rev) === e.rev) {
        if (sameState(row, e.state)) res.unchanged++;
        else res.holds.push({ entity, id: e.entity_id, party_id: e.party_id, reason: `database and change log differ at rev ${e.rev}` });
        continue;
      }
      // Missing row, or the ledger is newer: write the entry's full state.
      const names = Object.keys(e.state).filter((k) => cols.has(k) && k !== "logged_rev").map(literalSafe);
      const values = names.map((k) => e.state[k] ?? null);
      const colList = raw([...names, "logged_rev"].join(", "));
      const vals = values.reduce<Sql>((acc, v, i) => (i === 0 ? sql`${v}` : sql`${acc}, ${v}`), sql``);
      const updates = raw(names.filter((k) => k !== "id").map((k) => `${k} = excluded.${k}`).concat("logged_rev = excluded.logged_rev").join(", "));
      writes.push(sql`INSERT INTO ${raw(table)} (${colList}) VALUES (${vals}, ${e.rev})
        ON CONFLICT (id) DO UPDATE SET ${updates} WHERE ${raw(table)}.rev < excluded.rev`);
      res.applied++;
    }
    for (let i = 0; i < writes.length; i += 50) await main.batch(writes.slice(i, i + 50));
  }
  // Rows the ledger has never seen at all: not confirmed to anyone; held if they can be.
  for (const { entity, table } of ENTITY_TABLES) {
    if (entity !== "ticket" && entity !== "staff") continue;
    for (const r of await allRows(main, table)) {
      if (!newest.has(`${entity}:${r.id}`)) {
        res.holds.push({ entity, id: String(r.id), party_id: partyOf(entity, r), reason: "not in the change log" });
      }
    }
  }
  return res;
}

// ------------------------------------------------------------------ step 5

/** Held tickets cannot be admitted; held staff are disabled. Each change is audited; flushAll logs it. */
export async function applyHolds(main: SqlDriver, holds: Hold[], now: number, op: string): Promise<number> {
  const writes: Sql[] = [];
  for (const h of holds) {
    if (h.entity === "ticket") {
      writes.push(sql`UPDATE tickets SET hold_at = ${now}, hold_reason = ${h.reason}, rev = rev + 1, last_op = ${op}, last_action = 'recovery_hold'
        WHERE id = ${h.id} AND hold_at IS NULL`);
    } else if (h.entity === "staff") {
      writes.push(sql`UPDATE staff SET hold_at = ${now}, hold_reason = ${h.reason}, disabled_at = ${now}, rev = rev + 1, last_op = ${op},
          last_action = 'recovery_hold'
        WHERE id = ${h.id} AND hold_at IS NULL AND disabled_at IS NULL`);
    } else if (h.entity === "party" || h.entity === "organiser" || h.entity === "platform_admin") {
      // An unconfirmed switch-off: switched off until a site owner checks it
      // (a party is turned back on from the site owner page; it stays paused).
      const table = raw(h.entity === "party" ? "parties" : h.entity === "organiser" ? "organisers" : "platform_admins");
      writes.push(sql`UPDATE ${table} SET disabled_at = ${now}, rev = rev + 1, last_op = ${op}, last_action = 'recovery_hold'
        WHERE id = ${h.id} AND disabled_at IS NULL`);
    }
  }
  if (!writes.length) return 0;
  writes.push(sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
    SELECT party_id, ${now}, NULL, 'recovery_hold', 'ticket', id, rev, hold_reason FROM tickets WHERE last_op = ${op}
      AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.entity_type = 'ticket' AND a.entity_id = tickets.id AND a.entity_rev = tickets.rev)`);
  writes.push(sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
    SELECT party_id, ${now}, NULL, 'recovery_hold', 'staff', id, rev, hold_reason FROM staff WHERE last_op = ${op}
      AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.entity_type = 'staff' AND a.entity_id = staff.id AND a.entity_rev = staff.rev)`);
  for (const [entity, table, partyCol] of [["party", "parties", "id"], ["organiser", "organisers", `'${PLATFORM}'`], ["platform_admin", "platform_admins", `'${PLATFORM}'`]] as const) {
    writes.push(sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
      SELECT ${raw(partyCol)}, ${now}, NULL, 'recovery_hold', ${entity}, id, rev, 'unconfirmed switch-off during a recovery' FROM ${raw(table)} WHERE last_op = ${op}
        AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.entity_type = ${entity} AND a.entity_id = ${raw(table)}.id AND a.entity_rev = ${raw(table)}.rev)`);
  }
  for (let i = 0; i < writes.length; i += 50) await main.batch(writes.slice(i, i + 50));
  const n = await main.all<{ n: number }>(sql`SELECT (SELECT COUNT(*) FROM tickets WHERE last_op = ${op}) + (SELECT COUNT(*) FROM staff WHERE last_op = ${op})
    + (SELECT COUNT(*) FROM parties WHERE last_op = ${op} AND last_action = 'recovery_hold') + (SELECT COUNT(*) FROM organisers WHERE last_op = ${op})
    + (SELECT COUNT(*) FROM platform_admins WHERE last_op = ${op}) AS n`);
  return Number(n.results[0]?.n ?? 0);
}

/** Every session ends and every unused invitation is revoked: everyone signs in again. */
export async function revokeAccess(main: SqlDriver, now: number, op: string): Promise<{ sessions: number; invites: number }> {
  // Counted with reads: the script's driver does not report per-statement changes.
  const active = Number((await main.all<{ n: number }>(sql`SELECT (SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL)
    + (SELECT COUNT(*) FROM platform_sessions WHERE revoked_at IS NULL) AS n`)).results[0]?.n ?? 0);
  await main.batch([
    sql`UPDATE sessions SET revoked_at = ${now} WHERE revoked_at IS NULL`,
    sql`UPDATE platform_sessions SET revoked_at = ${now} WHERE revoked_at IS NULL`,
    sql`UPDATE organiser_invites SET revoked_at = ${now}, rev = rev + 1, last_op = ${op}, last_action = 'invite_revoked'
      WHERE used_at IS NULL AND revoked_at IS NULL`,
    sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
      SELECT ${PLATFORM}, ${now}, NULL, 'invite_revoked', 'organiser_invite', id, rev, 'controlled recovery' FROM organiser_invites WHERE last_op = ${op}
        AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.entity_type = 'organiser_invite' AND a.entity_id = organiser_invites.id AND a.entity_rev = organiser_invites.rev)`,
    sql`UPDATE invites SET revoked_at = ${now}, revoked_by = NULL, rev = rev + 1, last_op = ${op}, last_action = 'invite_revoked'
      WHERE used_at IS NULL AND revoked_at IS NULL`,
    sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
      SELECT party_id, ${now}, NULL, 'invite_revoked', 'invite', id, rev, 'controlled recovery' FROM invites WHERE last_op = ${op}
        AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.entity_type = 'invite' AND a.entity_id = invites.id AND a.entity_rev = invites.rev)`,
  ]);
  const invites = Number((await main.all<{ n: number }>(sql`SELECT (SELECT COUNT(*) FROM invites WHERE last_op = ${op} AND revoked_at = ${now})
    + (SELECT COUNT(*) FROM organiser_invites WHERE last_op = ${op} AND revoked_at = ${now}) AS n`)).results[0]?.n ?? 0);
  return { sessions: active, invites };
}

// ------------------------------------------------------------------ step 6

/** The database's admission state and pause_number match each control object (paused). Parties reopen from the dashboard. */
export async function syncPause(main: SqlDriver, ledger: SqlDriver, now: number, op: string): Promise<number> {
  const controls = (await ledger.all<{ party_id: string; state: string; pause_number: number }>(
    sql`SELECT party_id, state, pause_number FROM party_control`)).results;
  if (!controls.length) return 0;
  const parties = new Map((await main.all<{ id: string; admission_state: string; pause_number: number }>(
    sql`SELECT id, admission_state, pause_number FROM parties`)).results.map((p) => [p.id, p]));
  const due = controls.filter((c) => {
    const p = parties.get(c.party_id);
    return p && (p.admission_state !== "paused" || p.pause_number !== c.pause_number);
  });
  if (!due.length) return 0;
  const writes = due.map((c) => sql`UPDATE parties SET admission_state = 'paused', pause_number = ${c.pause_number},
      rev = rev + 1, last_op = ${op}, last_action = 'recovery_paused'
    WHERE id = ${c.party_id} AND (admission_state != 'paused' OR pause_number != ${c.pause_number})`);
  writes.push(sql`INSERT INTO audit (party_id, at, actor_staff_id, action, entity_type, entity_id, entity_rev, detail)
    SELECT id, ${now}, NULL, 'admission_paused', 'party', id, rev, 'controlled recovery' FROM parties WHERE last_op = ${op}
      AND NOT EXISTS (SELECT 1 FROM audit a WHERE a.entity_type = 'party' AND a.entity_id = parties.id AND a.entity_rev = parties.rev)`);
  await main.batch(writes);
  return due.length;
}

// ------------------------------------------------------------------ owner checks

/** Held tickets and staff, for the owner to resolve. */
export async function listHolds(main: SqlDriver, partyId: string) {
  const [t, s] = await Promise.all([
    main.all(sql`SELECT id, guest_name, status, used_at, hold_at, hold_reason FROM tickets WHERE party_id = ${partyId} AND hold_at IS NOT NULL`),
    main.all(sql`SELECT id, name, role, hold_at, hold_reason FROM staff WHERE party_id = ${partyId} AND hold_at IS NOT NULL`),
  ]);
  return { tickets: t.results, staff: s.results };
}
