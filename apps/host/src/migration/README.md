# Python data import (`cashu migrate`)

Owner's step-by-step cutover from the installed Python app, with the completeness table and known gaps: [docs/migration-runbook.md](../../../../docs/migration-runbook.md).

The native app keeps the same data folder the Python app used (macOS: `~/Library/Application Support/cashU`). `cashu migrate` imports the Python data into it in place, all or nothing; `cashu migrate verify` re-checks a finished import and changes nothing. One implementation (`inPlace.ts`, `cli.ts`) serves the terminal and the app's recovery screen ("Import my data").

```sh
cashu migrate --recovery-file ~/private/recovery-words.txt
cashu migrate verify
```

From an installed app without the launcher on `PATH`, the same commands run as:

```sh
ELECTRON_RUN_AS_NODE=1 /Applications/cashU.app/Contents/MacOS/cashU /Applications/cashU.app/Contents/Resources/shim.mjs migrate --recovery-file ~/private/recovery-words.txt
~/"Library/Application Support/cashU/bin/cashu" migrate verify   # the launcher, once the app has run natively
```

The shim resolves the data folder (`CASHU_DATA_DIR`, else the platform default) and runs the host binary's `migrate --data-dir <folder> ...` in the foreground; it never starts a host for it (a host refuses Python data). In a source checkout: `pnpm cashu-next migrate ...`.

## What it does

Quit the Python app first and keep it closed until the import finishes. The run holds the data folder's host lock, so no native host can start meanwhile, and refuses if one is running.

1. **preflight**: the folder must hold Python data (the same check the app's start-up uses) and no native data. A finished import is a no-op (`already_migrated`, exit 0, also without `--recovery-file`); an interrupted cutover is finished. Anything in the folder that is neither Python data nor the native app's own entries refuses the run.
2. **copy**: every Python file is hashed (path, size, SHA-256); the ones the importer reads are copied into `<folder>/.migration-<time>/source` and checked against that list. The originals are only read.
3. **import**: the copy is imported into `<folder>/.migration-<time>/native`: one encrypted vault per profile, the newest stored strategy version written byte for byte into the vault's `strategy/strategy.yaml` and `strategy.md` (where the native app reads it), and a profile's custom workspace folder and routine-permissions opt-in (`profiles/<slug>/workspace.json`) as the native `workspace/v1/<vault>.json`. The recovery words are saved before any vault exists: to the new `--recovery-file` (created once, mode 0600, outside the data folder), or, for the app (`--json`), shown once on the recovery screen and confirmed there.
4. **verify**: the staged import (including the strategy files and workspace settings) is re-verified against the copy, and the originals are hashed again; if the Python app wrote meanwhile the run fails with `source_changed`.
5. **cutover**: a journal is written, every original Python entry is moved unchanged into `<folder>/python-backup-<time>/`, the native data into the folder, and `<folder>/migration.json` records when, the backup's name and counts. A crash during this step leaves the journal; the app then reports `migration_incomplete` and the next `cashu migrate` finishes it.

Any failure before the cutover removes the staging folder and the vault key it created; the Python files stay exactly as they were. Keep `python-backup-<time>/` until `cashu migrate verify` passes and you have checked the app. Existing Enable Banking sessions and key files are not imported; reconnect with the bank. Connector code and approvals must be reinstalled or approved separately. Language preference, desktop window state, and the completed Python rename marker start fresh in the native app. The other device-local Python entries (`worker/`, `mcp/`, `legacy-migration.json`, `MIGRATED_FROM.txt`, `.env`, logs, locks, backups, temp leftovers; the full list is `DEVICE_LOCAL_EXCLUSIONS` in `sourceSeal.ts`) are moved intact into the backup and not imported.

The importer copies historical price, FX, macro, calendar, notification, connector fetch, MCP audit, and connector run state into the native device database and checks exact content after reopening it. Globally cataloged instruments and aliases with no profile reference are preserved there, along with price rows linked by source instrument ID. Mapped vault price bars are read by vault and instrument ID (`market/cachedData.ts`), also without a unique provider/symbol alias; imported PLN rates of a provider other than NBP fill the days NBP has no rate for (Python kept one rate per day whatever its source). Both `cashu migrate` and `cashu migrate verify` name every imported market-valued instrument the app still cannot price (no readable bars, or no PLN rate of its currency; `priceReach.ts`) instead of letting it count as 0. Referenced staged proposals and archived import files are copied into vault-key encrypted native blobs; `migrate verify` reopens each blob through the native import reader and compares its content with a fresh sealed copy of the backup.

## When it fails (T54 runbook)

The app shows its recovery screen for every start-up or import failure, with the failure code, whether the original files are untouched, and a button that copies a prompt for your assistant. The same prompt is in `<folder>/diagnostics/startup-failure-<time>.txt`, its validated form in `startup-failure-<time>.json`, and the latest typed record in `startup-failure.json`; none of them holds data, paths outside home, or the recovery words. The terminal commands print the report's path when they write one.

- `python_data_present`: Python data, not imported yet. Run `cashu migrate` (or "Import my data").
- `migrate_import_failed`: the import stopped before the cutover; nothing was changed. The detail says why (`source_changed`: the Python app was running; `cancelled`: the words were not confirmed). Fix the cause and run `cashu migrate` again.
- `migrate_verify_mismatch`: the imported data does not match the copy of the Python data. Do not delete the backup; send the report.
- `migration_incomplete`: the cutover was interrupted. Run `cashu migrate`; it finishes the moves the journal lists.

Never edit, move or delete files in the data folder by hand; only these commands change it.

Library use: `importPythonDataDir` / `verifyPythonMigration` (`oneShot.ts`) import a Python folder into a separate fresh target and re-verify it; the lab gate scripts call them directly with a test key store.
