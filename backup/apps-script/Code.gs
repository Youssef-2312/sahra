/**
 * Sahra backup to Google Drive (brief section 9).
 *
 * Runs in the PLATFORM owner's own Google account (never a party owner's). It
 * pulls a signed, read-only export from the Sahra Worker and keeps dated copies
 * in one Drive folder. Drive only stores copies: nothing reads Drive while the
 * site runs, and a restore always goes into fresh databases through
 * scripts/restore-drill.mjs and the controlled recovery procedure.
 *
 * Script Properties (Project Settings -> Script Properties):
 *   BACKUP_URL   https://sahra-staging.<account>.workers.dev   (staging first)
 *   BACKUP_KEY   the same value as the Worker secret BACKUP_KEY
 *   FOLDER_ID    the Drive folder for backups (the id in its URL)
 *   ALERT_EMAIL  optional; default: this account's own address
 *
 * Entry points: setup() once by hand; hourly() from the hourly trigger;
 * continueBackup() from one-off triggers that resume a backup; backupNow() by hand.
 *
 * Drive folder layout:
 *   screenshots/<id>.<ext>             each screenshot once (they never change)
 *   screenshots/index.json             id -> SHA-256, size, Drive file id
 *   sahra-backup-YYYY-MM-DDTHHmmZ/     one per backup (UTC time it started)
 *     manifest.json                    tables, measured database sizes, migrations
 *     <db>.<table>.<NNNN>.json.gz      rows, in primary key order, ledger last
 *     files.index.json                 this backup's screenshots with SHA-256 and size
 *     summary.json, SUMMARY.txt        what was copied and checked
 *   A backup still running is named "INCOMPLETE sahra-backup-..." and renamed at the end.
 */

var RUN_LIMIT_MS = 5 * 60 * 1000;        // stop well before Apps Script's 6-minute limit
var DAILY_BUDGET_MS = 75 * 60 * 1000;    // of the 90 minutes/day of trigger runtime (consumer accounts)
var PAGE = 400;                          // rows per request (the Worker allows at most 500)
var PART_ROWS = 5000;                    // rows per part file
var FILE_BATCH = 20;                     // screenshots between progress saves
var NIGHT_HOUR = 3;                      // nightly backups start from 03:00 in the script's time zone
var KEEP_ALL_HOURS = 48;                 // keep every backup this long, then one per day
var KEEP_DAYS = 30;
var MAX_FAILURES = 3;                    // runs in a row before a backup is abandoned (and reported)
var ALERT_EVERY_MS = 6 * 3600 * 1000;    // at most one email per problem per 6 hours
var NAME_PREFIX = 'sahra-backup-';
var INCOMPLETE = 'INCOMPLETE ';

// ------------------------------------------------------------------ entry points

/** Run once by hand: checks the settings and the connection, creates the folders and the hourly trigger. */
function setup() {
  var cfg = config_();
  var s = api_(cfg, '/api/backup/schedule', '');
  screenshotsFolder_(cfg);
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'hourly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('hourly').timeBased().everyHours(1).create();
  log_('setup done; the Worker says backups are ' + s.frequency + ' now (' + (s.reasons.join('; ') || 'no party selling or on tonight') + ')');
  return s;
}

/** Hourly trigger: continues a running backup, or starts one when it is due. */
function hourly() {
  return tick_(false);
}

/** One-off trigger set by a run that stopped before finishing. */
function continueBackup() {
  return tick_(false);
}

/** By hand: start a backup now (or continue the running one). */
function backupNow() {
  return tick_(true);
}

// ------------------------------------------------------------------ main loop

function tick_(force) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return 'busy';
  var started = Date.now();
  var props = PropertiesService.getScriptProperties();
  var result = 'idle';
  try {
    var cfg = config_();
    var state = readJson_(props, 'STATE');
    if (!state) {
      var due = force ? { due: true, frequency: 'manual' } : isDue_(cfg, props, started);
      if (!due.due) return 'not_due';
      if (!force && overBudget_(props, started)) {
        alert_(props, 'budget', 'Sahra backup skipped: daily time budget used',
          'The backup script has used more than ' + Math.round(DAILY_BUDGET_MS / 60000) + ' minutes today (Apps Script allows 90 minutes of trigger time per day). '
          + 'Backups resume tomorrow. If this repeats, there are too many hourly runs or too many new screenshots per hour.');
        return 'over_budget';
      }
      state = start_(cfg, due.frequency, started);
      props.setProperty('STATE', JSON.stringify(state));
    }
    var done = work_(cfg, props, state, started);
    if (done) {
      deleteTriggers_('continueBackup');
      result = 'done';
    } else {
      continueLater_();
      result = 'continues';
    }
  } catch (e) {
    result = 'failed';
    failed_(props, e);
  } finally {
    addRuntime_(props, Date.now() - started);
    lock.releaseLock();
  }
  return result;
}

function isDue_(cfg, props, now) {
  var s = api_(cfg, '/api/backup/schedule', '');
  var last = Number(props.getProperty('LAST_SUCCESS_AT') || 0);
  var age = now - last;
  // Tell the owner when backups stopped succeeding.
  if (last && ((s.frequency === 'hourly' && age > 3 * 3600 * 1000) || age > 30 * 3600 * 1000)) {
    alert_(props, 'stale', 'Sahra backup: no successful backup for ' + Math.round(age / 3600000) + ' hours',
      'The last successful backup was at ' + new Date(last).toISOString() + '. Last error: ' + (props.getProperty('LAST_ERROR') || 'none recorded') + '.');
  }
  if (s.frequency === 'hourly') return { due: age >= 55 * 60 * 1000, frequency: 'hourly' };
  var hour = Number(Utilities.formatDate(new Date(now), Session.getScriptTimeZone(), 'H'));
  var nightly = (age >= 20 * 3600 * 1000 && hour >= NIGHT_HOUR && hour < NIGHT_HOUR + 3) || age >= 26 * 3600 * 1000;
  return { due: nightly, frequency: 'nightly' };
}

function start_(cfg, frequency, now) {
  var root = DriveApp.getFolderById(cfg.folderId);
  var name = NAME_PREFIX + Utilities.formatDate(new Date(now), 'UTC', "yyyy-MM-dd'T'HHmm'Z'");
  var folder = root.createFolder(INCOMPLETE + name);
  // Row counts read every row once more, so only nightly (and manual) backups ask for them.
  var manifest = api_(cfg, '/api/backup/manifest', frequency === 'hourly' ? '' : 'counts=1');
  if (manifest.format !== 'sahra-backup-1') throw new Error('unknown export format ' + manifest.format);
  writeText_(folder, 'manifest.json', JSON.stringify(manifest, null, 1));
  return {
    name: name, folderId: folder.getId(), frequency: frequency, startedAt: now, runs: 0, failures: 0,
    order: manifest.order.map(function (t) { return t.db + '.' + t.table; }),
    phase: 'tables', t: 0, cursor: null, part: 1, rows: {}, parts: [], requests: 1,
    filePart: 0, fileRow: 0, files: { listed: 0, copied: 0, alreadyCopied: 0, bytesCopied: 0, failed: 0, problems: [] },
    sizes: {
      main: manifest.databases.main.size_bytes,
      ledger: manifest.databases.ledger.size_bytes,
      files: manifest.databases.files.configured === false ? null : manifest.databases.files.size_bytes
    }
  };
}

/** Does as much as fits in this run. Returns true when the backup is complete. */
function work_(cfg, props, state, started) {
  state.runs++;
  var save = function () { props.setProperty('STATE', JSON.stringify(state)); };
  var timeLeft = function () { return Date.now() - started < RUN_LIMIT_MS; };
  var folder = DriveApp.getFolderById(state.folderId);

  // 1. Tables, page by page, in the Worker's order (ledger last).
  while (state.phase === 'tables') {
    if (state.t >= state.order.length) { state.phase = 'files'; save(); break; }
    var dbTable = state.order[state.t];
    var buffer = [];
    var finished = false;
    while (timeLeft() && buffer.length < PART_ROWS) {
      var q = 'limit=' + PAGE + (state.cursor ? '&after=' + state.cursor : '');
      var page = api_(cfg, '/api/backup/rows/' + dbTable.replace('.', '/'), q);
      state.requests++;
      Array.prototype.push.apply(buffer, page.rows);
      state.cursor = page.next;
      if (!page.next) { finished = true; break; }
    }
    if (buffer.length || (finished && state.part === 1)) {
      var partName = dbTable + '.' + pad4_(state.part) + '.json.gz';
      writeGz_(folder, partName, JSON.stringify(buffer));
      state.parts.push(partName);
      state.part++;
      state.rows[dbTable] = (state.rows[dbTable] || 0) + buffer.length;
    }
    if (finished) { state.t++; state.cursor = null; state.part = 1; }
    state.failures = 0;
    save();
    if (!timeLeft()) return false;
  }

  // 2. Screenshots: only the ones not already in Drive, each checked by size and SHA-256.
  if (state.phase === 'files') {
    var shots = screenshotsFolder_(cfg);
    var index = readIndex_(shots);
    var parts = state.parts.filter(function (p) { return p.indexOf('files.files.') === 0; });
    var sinceSave = 0;
    while (state.filePart < parts.length) {
      var rows = JSON.parse(readGz_(folder, parts[state.filePart]));
      while (state.fileRow < rows.length) {
        if (!timeLeft()) { saveIndex_(shots, index); save(); return false; }
        var f = rows[state.fileRow];
        var have = index.files[String(f.id)];
        if (have && have.size === f.size) {
          state.files.alreadyCopied++;
        } else {
          var problem = copyScreenshot_(cfg, shots, f, index);
          state.requests++;
          if (problem) {
            state.files.failed++;
            // Only the first 50 are kept (Script Properties hold at most 9 KB per value).
            if (state.files.problems.length < 50) state.files.problems.push({ id: f.id, problem: problem });
          }
          else { state.files.copied++; state.files.bytesCopied += f.size; }
          sinceSave++;
        }
        state.files.listed++;
        state.fileRow++;
        if (sinceSave >= FILE_BATCH) { saveIndex_(shots, index); save(); sinceSave = 0; }
      }
      state.filePart++;
      state.fileRow = 0;
    }
    saveIndex_(shots, index);
    // This backup's screenshots, with the hash each was checked against.
    var mine = {};
    parts.forEach(function (p) {
      JSON.parse(readGz_(folder, p)).forEach(function (r) { var e = index.files[String(r.id)]; if (e) mine[String(r.id)] = e; });
    });
    writeText_(folder, 'files.index.json', JSON.stringify({ v: 1, folder: 'screenshots', files: mine }));
    state.phase = 'summary';
    state.failures = 0;
    save();
  }

  // 3. Summary, rename, retention.
  var finishedAt = Date.now();
  var summary = {
    backup: state.name, frequency: state.frequency, started_at: new Date(state.startedAt).toISOString(),
    finished_at: new Date(finishedAt).toISOString(), minutes: Math.round((finishedAt - state.startedAt) / 6000) / 10,
    runs: state.runs, requests: state.requests,
    database_size_bytes: state.sizes,
    rows: state.rows, parts: state.parts.length,
    screenshots: state.files,
    ok: state.files.failed === 0
  };
  writeText_(folder, 'summary.json', JSON.stringify(summary, null, 1));
  writeText_(folder, 'SUMMARY.txt', summaryText_(summary));
  folder.setName(state.name);
  props.setProperty('LAST_SUCCESS_AT', String(state.startedAt));
  props.setProperty('LAST_BACKUP', state.name);
  props.deleteProperty('STATE');
  props.deleteProperty('LAST_ERROR');
  if (!summary.ok) {
    alert_(props, 'integrity', 'Sahra backup: ' + state.files.failed + ' screenshot(s) failed the check',
      'Backup ' + state.name + ' finished, but these screenshots could not be copied and verified (they are tried again next time):\n'
      + state.files.problems.slice(0, 50).map(function (p) { return '  ' + p.id + ': ' + p.problem; }).join('\n'));
  }
  prune_(cfg, finishedAt);
  log_(summaryText_(summary));
  return true;
}

/** Downloads one screenshot, checks it, saves it, reads it back from Drive and checks again. Returns a problem or null. */
function copyScreenshot_(cfg, shots, f, index) {
  var res = signedFetch_(cfg, '/api/backup/file/' + f.id, '');
  if (res.getResponseCode() !== 200) return 'download answered ' + res.getResponseCode();
  var headers = lowerKeys_(res.getAllHeaders ? res.getAllHeaders() : res.getHeaders());
  var bytes = res.getContent();
  var sha = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes));
  if (sha !== String(headers['x-sahra-sha256'])) return 'SHA-256 differs from the Worker\'s';
  if (bytes.length !== f.size || String(bytes.length) !== String(headers['x-sahra-size'])) return 'size differs (' + bytes.length + ' bytes, list says ' + f.size + ')';
  var name = f.id + extOf_(f.content_type);
  var old = shots.getFilesByName(name);
  while (old.hasNext()) old.next().setTrashed(true);
  var file = shots.createFile(Utilities.newBlob(bytes, 'application/octet-stream', name));
  // Read back what Drive stored.
  var back = file.getBlob().getBytes();
  var backSha = hex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, back));
  if (back.length !== f.size || file.getSize() !== f.size || backSha !== sha) {
    file.setTrashed(true);
    return 'the copy in Drive does not match';
  }
  index.files[String(f.id)] = { name: name, sha256: sha, size: f.size, type: f.content_type, drive_id: file.getId(), copied_at: new Date().toISOString() };
  return null;
}

// ------------------------------------------------------------------ Worker API

function config_() {
  var p = PropertiesService.getScriptProperties();
  var url = String(p.getProperty('BACKUP_URL') || '').replace(/\/+$/, '');
  var key = String(p.getProperty('BACKUP_KEY') || '');
  var folderId = String(p.getProperty('FOLDER_ID') || '');
  var m = /^https:\/\/([A-Za-z0-9.-]+)(:[0-9]+)?$/.exec(url) || /^http:\/\/(127\.0\.0\.1|localhost)(:[0-9]+)?$/.exec(url);
  if (!m) throw new Error('Script Property BACKUP_URL must be the Worker\'s https:// address, without a path');
  if (!/^[A-Za-z0-9_-]{43,}=*$/.test(key)) throw new Error('Script Property BACKUP_KEY is missing or too short');
  if (!folderId) throw new Error('Script Property FOLDER_ID is missing');
  var b64 = key.replace(/=+$/, '');
  while (b64.length % 4) b64 += '=';
  return { base: url, host: (m[1] + (m[2] || '')).toLowerCase(), keyBytes: Utilities.base64DecodeWebSafe(b64), folderId: folderId };
}

/** A GET signed with BACKUP_KEY (same rule as src/backup/auth.ts). Retries temporary failures. */
function signedFetch_(cfg, path, query) {
  var last = null;
  for (var attempt = 0; attempt < 4; attempt++) {
    if (attempt) Utilities.sleep(2000 * Math.pow(2, attempt - 1));
    var t = String(Math.floor(Date.now() / 1000));
    var text = ['SAHRA-BACKUP-1', 'GET', cfg.host, path, query, t].join('\n');
    var sig = hex_(Utilities.computeHmacSha256Signature(Utilities.newBlob(text).getBytes(), cfg.keyBytes));
    try {
      last = UrlFetchApp.fetch(cfg.base + path + (query ? '?' + query : ''), {
        method: 'get', muteHttpExceptions: true, followRedirects: false,
        headers: { 'x-sahra-backup-time': t, 'x-sahra-backup-signature': sig }
      });
    } catch (e) {
      last = e;
      continue;
    }
    var code = last.getResponseCode();
    if (code !== 429 && code !== 500 && code !== 502 && code !== 503 && code !== 504) return last;
    // 503 backup_not_configured will not fix itself: no retry.
    if (code === 503 && /backup_not_configured/.test(last.getContentText())) return last;
  }
  if (last instanceof Error) throw last;
  return last;
}

function api_(cfg, path, query) {
  var res = signedFetch_(cfg, path, query);
  var code = res.getResponseCode();
  if (code !== 200) throw new Error('GET ' + path + ' answered ' + code + ': ' + String(res.getContentText()).slice(0, 200));
  return JSON.parse(res.getContentText());
}

// ------------------------------------------------------------------ Drive

function screenshotsFolder_(cfg) {
  var root = DriveApp.getFolderById(cfg.folderId);
  var it = root.getFoldersByName('screenshots');
  return it.hasNext() ? it.next() : root.createFolder('screenshots');
}

function readIndex_(shots) {
  var it = shots.getFilesByName('index.json');
  if (!it.hasNext()) return { v: 1, files: {} };
  return JSON.parse(it.next().getBlob().getDataAsString());
}

function saveIndex_(shots, index) {
  var text = JSON.stringify(index);
  var it = shots.getFilesByName('index.json');
  if (it.hasNext()) it.next().setContent(text);
  else shots.createFile(Utilities.newBlob(text, 'application/json', 'index.json'));
}

function writeText_(folder, name, text) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) it.next().setTrashed(true);
  return folder.createFile(Utilities.newBlob(text, 'application/json', name));
}

function writeGz_(folder, name, text) {
  var it = folder.getFilesByName(name);
  while (it.hasNext()) it.next().setTrashed(true);
  return folder.createFile(Utilities.gzip(Utilities.newBlob(text, 'application/json'), name));
}

function readGz_(folder, name) {
  var it = folder.getFilesByName(name);
  if (!it.hasNext()) throw new Error('part file missing: ' + name);
  return Utilities.ungzip(it.next().getBlob()).getDataAsString();
}

/** Keeps every backup from the last 48 hours, then the newest of each day for 30 days. Screenshots are never deleted. */
function prune_(cfg, now) {
  var root = DriveApp.getFolderById(cfg.folderId);
  var it = root.getFolders();
  var byDay = {};
  var list = [];
  while (it.hasNext()) {
    var f = it.next();
    var m = /^(?:INCOMPLETE )?sahra-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})Z$/.exec(f.getName());
    if (!m) continue;
    var at = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
    list.push({ folder: f, at: at, day: m[1] + m[2] + m[3], incomplete: f.getName().indexOf(INCOMPLETE) === 0 });
  }
  list.sort(function (a, b) { return b.at - a.at; });
  list.forEach(function (x) {
    var age = now - x.at;
    if (age < KEEP_ALL_HOURS * 3600 * 1000) return;
    if (!x.incomplete && age < KEEP_DAYS * 24 * 3600 * 1000 && !byDay[x.day]) { byDay[x.day] = true; return; }
    x.folder.setTrashed(true);
  });
}

// ------------------------------------------------------------------ failures, alerts, budget

function failed_(props, e) {
  var msg = String(e && e.message ? e.message : e).slice(0, 500);
  props.setProperty('LAST_ERROR', new Date().toISOString() + ' ' + msg);
  log_('backup run failed: ' + msg);
  var state = readJson_(props, 'STATE');
  if (!state) {
    alert_(props, 'failed', 'Sahra backup failed', 'The backup could not start: ' + msg);
    return;
  }
  state.failures = (state.failures || 0) + 1;
  if (state.failures >= MAX_FAILURES) {
    props.deleteProperty('STATE');
    deleteTriggers_('continueBackup');
    alert_(props, 'failed', 'Sahra backup failed',
      'Backup ' + state.name + ' failed ' + state.failures + ' runs in a row and was abandoned (its folder stays marked INCOMPLETE). '
      + 'The next hourly run starts a new one. Last error: ' + msg);
  } else {
    props.setProperty('STATE', JSON.stringify(state));
    continueLater_();
  }
}

/** Email from this account to itself (or ALERT_EMAIL). Plain text, at most one per problem per 6 hours. */
function alert_(props, kind, subject, body) {
  var key = 'ALERT_' + kind.toUpperCase();
  var last = Number(props.getProperty(key) || 0);
  if (Date.now() - last < ALERT_EVERY_MS) return;
  props.setProperty(key, String(Date.now()));
  var to = props.getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, subject, body + '\n\nSent by the Sahra backup script in this Google account (Apps Script).');
}

function overBudget_(props, now) {
  var r = readJson_(props, 'RUNTIME');
  return !!r && r.day === dayOf_(now) && r.ms > DAILY_BUDGET_MS;
}

function addRuntime_(props, ms) {
  var day = dayOf_(Date.now());
  var r = readJson_(props, 'RUNTIME');
  if (!r || r.day !== day) r = { day: day, ms: 0, runs: 0 };
  r.ms += ms;
  r.runs++;
  props.setProperty('RUNTIME', JSON.stringify(r));
}

function continueLater_() {
  deleteTriggers_('continueBackup');
  ScriptApp.newTrigger('continueBackup').timeBased().after(60 * 1000).create();
}

function deleteTriggers_(handler) {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === handler) ScriptApp.deleteTrigger(t);
  });
}

// ------------------------------------------------------------------ small helpers

function summaryText_(s) {
  var lines = [
    'Sahra backup ' + s.backup + ' (' + s.frequency + ')',
    'Started ' + s.started_at + ', finished ' + s.finished_at + ' (' + s.minutes + ' min, ' + s.runs + ' run(s), ' + s.requests + ' requests)',
    'Measured database sizes (D1): main ' + mb_(s.database_size_bytes.main) + ', ledger ' + mb_(s.database_size_bytes.ledger)
      + ', screenshots ' + (s.database_size_bytes.files === null ? 'not configured' : mb_(s.database_size_bytes.files)),
    'Rows:'
  ];
  Object.keys(s.rows).forEach(function (k) { lines.push('  ' + k + ': ' + s.rows[k]); });
  lines.push('Screenshots: ' + s.screenshots.listed + ' listed, ' + s.screenshots.copied + ' copied and verified this time (' + mb_(s.screenshots.bytesCopied)
    + '), ' + s.screenshots.alreadyCopied + ' already in Drive, ' + s.screenshots.failed + ' problem(s)');
  lines.push(s.ok ? 'Result: OK' : 'Result: PROBLEMS (see summary.json)');
  return lines.join('\n') + '\n';
}

function mb_(n) { return n === null || n === undefined ? 'unknown' : (Math.round(n / 104857.6) / 10) + ' MB'; }
function pad4_(n) { return ('000' + n).slice(-4); }
function dayOf_(ms) { return Utilities.formatDate(new Date(ms), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function extOf_(type) { return type === 'image/png' ? '.png' : type === 'image/webp' ? '.webp' : '.jpg'; }

function hex_(bytes) {
  var s = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] + 256) % 256;
    s += (b < 16 ? '0' : '') + b.toString(16);
  }
  return s;
}

function lowerKeys_(o) {
  var out = {};
  Object.keys(o || {}).forEach(function (k) { out[k.toLowerCase()] = Array.isArray(o[k]) ? o[k][0] : o[k]; });
  return out;
}

function readJson_(props, key) {
  var v = props.getProperty(key);
  return v ? JSON.parse(v) : null;
}

function log_(msg) { console.log(msg); }
