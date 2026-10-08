# Sahra backup to Google Drive (Apps Script)

`Code.gs` copies Sahra's databases and payment screenshots into a folder in the
**platform owner's own Google Drive**, from the owner's own Google account. It
never uses a party owner's account. Drive only holds copies: nothing reads Drive
while the site runs; a restore goes into new databases with
`scripts/restore-drill.mjs` and then the controlled recovery procedure.

## What it does

- Every hour (one trigger) it asks the Worker `GET /api/backup/schedule`.
  - **Nightly (full) backup** (`sahra-backup-...`): every table and the
    screenshots, from 03:00 in the script's time zone, or as soon as the last
    full one is more than 26 hours old. Never skipped.
  - **Hourly backup** (`sahra-ledger-...`): only the ledger (change log, intents,
    control objects), the screenshot list and NEW screenshots; while a party's
    admission is open, on a party night (12 hours before the start until 6 hours
    after the end), or while a party is selling (not switched off, not over, a
    change in the last 24 hours). Skipped while the Worker says the site is past
    about half of its free daily limits (`budget_ok: false`).
  - A restore from Drive uses the newest nightly plus the newest hourly:
    `node scripts/restore-drill.mjs <sahra-backup-...> --ledger <sahra-ledger-...>`;
    the recovery replay brings back every change made after the nightly.
- A backup = `manifest.json` (tables, measured database sizes, migrations), every
  table page by page (`/api/backup/rows/...`, ledger last), then the screenshots.
  Each part file is gzipped JSON.
- After a backup passed every check, the script reports it to the Worker
  (`POST /api/backup/done`, signed like every call). The Worker's health check
  tells the site owners when the last reported backup is more than 26 hours old,
  so a script that stopped running is noticed too.
- Screenshots of every screenshot database (FILES, FILES_2, ...) are stored once in
  `screenshots/` (they never change): database 1 under its id, the others as
  `files_N-<id>`. Each new one is downloaded, its SHA-256 compared with the
  Worker's, its size with the list, then saved to Drive, read back from Drive and
  checked again. Screenshots the site's retention already deleted are listed as
  "purged": not downloaded and not a failure; a copy made before the deletion stays
  in Drive. Progress is saved
  in Script Properties every 20 files; a run stops after 5 minutes (Apps Script
  stops at 6) and a one-off trigger continues one minute later.
- `summary.json` and `SUMMARY.txt` in each backup folder: rows per table,
  screenshots copied / already there / purged / failed, the measured database sizes (D1's
  own `size_after`), time taken.
- Keeps every backup for 48 hours, then the newest nightly of each day for 30
  days (hourly ones are deleted after 48 hours). Screenshots are never deleted.
- Email to the owner (from this account to itself, or `ALERT_EMAIL`), at most one
  per problem per 6 hours: a backup could not start; failed 3 runs in a row
  (abandoned, the next hour starts a new one); a screenshot failed its check; no
  successful backup for 3 hours (in hourly mode) or 30 hours; the daily time
  budget is used up.
- Daily budget: Apps Script allows 90 minutes of trigger runtime per day on a
  personal account. The script counts its own runtime and starts no new backup
  after 75 minutes in a day.

## Install (the owner, staging first)

1. **Secret for the Worker.** The same random key goes to two places (the
   Worker and the script), so it is written to a file for a moment. On your own
   computer:

   ```
   node scripts/gen-secret.mjs > ..\backup-key.txt
   npx wrangler secret put BACKUP_KEY --env staging < ..\backup-key.txt
   ```

   (`../backup-key.txt` on macOS/Linux: the file goes NEXT TO the repository
   folder, never inside it, so it cannot be committed.) Keep it open for step 4,
   then delete it. Do not send the value to anyone.
   Production later gets its OWN key (`npx wrangler secret put BACKUP_KEY
   --env=""`). Until the secret exists, every backup endpoint answers 503.
2. **Drive folder.** In the platform owner's Google Drive create a folder, e.g.
   `Sahra backups (staging)`. Open it; the folder id is the last part of its URL
   (`https://drive.google.com/drive/folders/<FOLDER_ID>`). Do not share it.
3. **Script.** Go to https://script.google.com with the same account, New
   project, name it `Sahra backup (staging)`. Replace `Code.gs` with this
   folder's `Code.gs`. Project Settings: tick "Show appsscript.json manifest
   file in editor", then replace `appsscript.json` with this folder's file (set
   `timeZone` to your own if it is not Cairo).
4. **Script Properties** (Project Settings -> Script Properties):
   - `BACKUP_URL` = `https://sahra-staging.<your-account>.workers.dev`
   - `BACKUP_KEY` = the value from step 1
   - `FOLDER_ID` = the id from step 2
   - optional `ALERT_EMAIL` = where alerts go (default: this account)
5. In the editor choose the function `setup` and press Run. Google asks for
   permission (Drive, external requests, triggers, sending email as you). The log
   says whether backups are hourly or nightly now. It installs the hourly
   trigger.
6. Choose `backupNow` and press Run once to make the first backup right away
   (it continues by itself if it needs more than 5 minutes). Then check the
   folder: a `sahra-backup-...` folder with `SUMMARY.txt`, and `screenshots/`.
7. **Restore drill** (on your computer, nothing touches Cloudflare): download the
   newest `sahra-backup-...` folder, the newest `sahra-ledger-...` folder (if any)
   and the `screenshots` folder from Drive into one folder, then

   ```
   node scripts/restore-drill.mjs "<download>/sahra-backup-YYYY-MM-DDTHHmmZ" --ledger "<download>/sahra-ledger-YYYY-MM-DDTHHmmZ"
   ```

   (without `--ledger` if there is no hourly backup yet).

   It must end with "Restore drill OK". Do this once after installing, and again
   after big changes (a new migration).
8. Production: repeat with a second script project, a separate Drive folder and
   a separate key, once staging has run for a few days.

To stop backups: delete the triggers (Triggers page of the script) or remove
the `BACKUP_KEY` secret from the Worker (every call then answers 503 and the
script emails you).

## Limits to keep in mind

- One run may last at most 6 minutes; the script stops at 5.
- 90 minutes of trigger runtime per day (personal account); the script stops
  starting backups after 75.
- `UrlFetchApp`: 20,000 calls per day on a personal account. A backup of 4,000
  tickets is about 120 calls plus one per NEW screenshot.
- Script Properties: 9 KB per value; the progress record stays well below.
- These limits are Google's published consumer quotas; they can change.
