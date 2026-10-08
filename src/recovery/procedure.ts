// The controlled recovery procedure in order (brief section 8.3), shared by the
// tests and scripts/recover.mjs. `restore` is the owner's step (Time Travel);
// everything else is here. Safe to run again after a stop.

import type { SqlDriver } from "../db/driver";
import { applyHolds, flushAll, holdsFromIntents, pauseAll, reopenedTickets, replay, revokeAccess, syncPause, verify, type Hold } from "./index";

export interface RecoveryReport {
  paused: string[];
  mainChecked: boolean;
  flushedBefore: number;
  mismatchesBefore: number;
  replayed: number;
  holds: Hold[];
  held: number;
  sessionsRevoked: number;
  invitesRevoked: number;
  partiesSynced: number;
  flushedAfter: number;
  finalOk: boolean;
}

export async function recover(o: {
  main: SqlDriver;
  ledger: SqlDriver;
  now: () => number;
  /** Restores the main database (owner's credential). Runs after the ledger is complete. */
  restore: () => Promise<void>;
  log?: (line: string) => void;
}): Promise<RecoveryReport> {
  const log = o.log ?? (() => {});
  const op = `recovery-${o.now()}`;

  // 1. Pause every party: scanners answer "paused" from the control object.
  const paused = await pauseAll(o.ledger, o.now(), "recovery");
  log(`1. paused ${paused.length} part${paused.length === 1 ? "y" : "ies"} (control objects)`);

  // 2. Complete the ledger from the main database, then check they match.
  let mainChecked = false;
  let flushedBefore = 0;
  let mismatchesBefore = 0;
  const holds = new Map<string, Hold>();
  try {
    flushedBefore = await flushAll(o.main, o.ledger, o.now());
    const v = await verify(o.main, o.ledger);
    mismatchesBefore = v.mismatches.length;
    mainChecked = v.ok;
    for (const m of v.mismatches) {
      if (["ticket", "staff", "party", "organiser", "platform_admin"].includes(m.entity)) holds.set(`${m.entity}:${m.id}`, { ...m, reason: `change log ${m.problem} before restore` });
    }
    log(`2. main database reachable: ${flushedBefore} change(s) copied to the ledger; ${v.rows} rows checked, ${v.mismatches.length} mismatch(es)`);
  } catch (e) {
    log(`2. main database could not be checked (${(e as Error).message}); unconfirmed changes will be held`);
  }
  if (!mainChecked) {
    for (const h of await holdsFromIntents(o.ledger)) holds.set(`${h.entity}:${h.id}`, h);
  }

  // 3. Restore (owner).
  await o.restore();
  log("3. main database restored");

  // 4. Replay: newest rev per entity wins.
  const r = await replay(o.main, o.ledger);
  for (const h of r.holds) holds.set(`${h.entity}:${h.id}`, h);
  log(`4. replayed ${r.applied} entr${r.applied === 1 ? "y" : "ies"}; ${r.unchanged} already current`);

  // 5. Holds, then everyone signs in again.
  const list = [...holds.values()];
  const held = await applyHolds(o.main, list, o.now(), op);
  const revoked = await revokeAccess(o.main, o.now(), op);
  log(`5. ${held} held (owner resolves each); ${revoked.sessions} session(s) ended, ${revoked.invites} unused invitation(s) revoked`);

  // 6. The database's pause_number matches each control object; parties stay paused.
  const synced = await syncPause(o.main, o.ledger, o.now(), op);
  log(`6. ${synced} part${synced === 1 ? "y" : "ies"} set to the control object's pause_number (still paused; reopen from the dashboard)`);

  // Record this procedure's own changes. Then replay once more: a request that was
  // still running when maintenance began may have reached the ledger after the
  // first replay; the newest state must still win.
  let flushedAfter = await flushAll(o.main, o.ledger, o.now());
  const late = await replay(o.main, o.ledger);
  if (late.applied || late.holds.length) {
    const lateHeld = await applyHolds(o.main, late.holds, o.now(), op);
    flushedAfter += await flushAll(o.main, o.ledger, o.now());
    log(`   late changes: ${late.applied} replayed, ${lateHeld} held`);
    for (const h of late.holds) holds.set(`${h.entity}:${h.id}`, h);
  }
  const final = await verify(o.main, o.ledger);
  // Nothing reopens: every ticket the change log says is used is used in the database.
  const reopened = await reopenedTickets(o.main, o.ledger);
  const finalOk = final.ok && reopened.length === 0;
  log(`final check: ${final.ok ? "every row matches the change log" : `${final.mismatches.length} mismatch(es)`}; ${reopened.length} ticket(s) reopened${finalOk ? " (OK)" : ""}`);

  return {
    paused, mainChecked, flushedBefore, mismatchesBefore, replayed: r.applied, holds: [...holds.values()], held,
    sessionsRevoked: revoked.sessions, invitesRevoked: revoked.invites, partiesSynced: synced, flushedAfter, finalOk,
  };
}
