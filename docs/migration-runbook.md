# Moving from the Python app to the native app (runbook)

The native cashU.app (Electron) replaces the Python cashU.app and uses the same data folder,
`~/Library/Application Support/cashU`. Your data comes over once, with `cashu migrate` or the
"Import my data" button on the app's recovery screen. This page is the owner's checklist for that
cutover on one Mac with two profiles (`profile-a`, `profile-b`). It names no amounts and no accounts.

Shell variables used below (zsh or bash):

```sh
D="$HOME/Library/Application Support/cashU"
# Before the native host has ever run (no "$D/bin/cashu" yet):
CASHU=(env ELECTRON_RUN_AS_NODE=1 /Applications/cashU.app/Contents/MacOS/cashU /Applications/cashU.app/Contents/Resources/shim.mjs)
# After the native app has opened once ("$D/bin/cashu" exists):
# CASHU=("$D/bin/cashu")
```

## 1. What the migration does and guarantees

- **All or nothing.** It copies the Python files it reads into `$D/.migration-<time>/source`,
  imports that copy into `$D/.migration-<time>/native`, verifies the result against the copy, and
  checks that the originals did not change meanwhile. Only then does it switch over. Any failure
  before the switch removes its staging folder and the vault key it created; the Python files stay
  exactly as they were.
- **Nothing is deleted.** The switch moves every top-level Python entry unchanged into
  `$D/python-backup-<time>/`, moves the native data into `$D`, and writes `$D/migration.json`
  (time, backup folder name, counts). An interrupted switch leaves a journal; the next
  `cashu migrate` finishes it.
- **One run for both profiles.** Each Python profile becomes its own encrypted vault. New 24-word
  recovery words are created once for the import.
- **Roll back by hand** (only if you decide to go back to the Python app):
  1. Quit cashU (also from the menu bar, "Zakończ" / "Quit").
  2. Move everything in `$D` except `python-backup-<time>` into a new folder outside `$D`, for
     example `~/Library/Application Support/cashU-native-<date>` (keep it, do not delete).
  3. Move every entry of `$D/python-backup-<time>/` back into `$D`, then remove the empty
     `python-backup-<time>` folder.
  4. Reinstall the Python app from the zip you made in step 3.4 of the checklist, then reinstall its
     worker agent and MCP registrations.
  The external copy from step 3.3 is the second way back: quit everything and restore it with
  `ditto`.

## 2. Known gaps (read before you start)

| Gap | Effect on the cutover | What to do until it is fixed |
|---|---|---|
| G4: classifier settings from `$D/.env` and the Anthropic key in the Python keychain are not imported (`.env` itself moves intact into the backup) | Categorization falls back to local Ollama defaults | Step 6.6 |

## 3. Prerequisites

1. **Python app on its last release.** The importer reads schema revisions 0025 to 0030 only:
   ```sh
   sqlite3 -readonly "$D/cashu.db" 'select version_num from alembic_version'
   ```
   Expect one of `0025_topic_view_sources` ... `0030_sync_outbox_post`. If older, update the
   Python app once (Sparkle), open it, quit it, check again.
2. **Write down net worth per currency for each profile** (for step 5.3): the Python app's overview,
   or `/Applications/cashU.app/Contents/MacOS/cashu --profile profile-a stats` (and `profile-b`). Keep the
   numbers off the repo and delete them after step 5.
3. **Belt and braces copy** to an external disk, with everything quit (step 4 below):
   ```sh
   X="/Volumes/<disk>/cashU-before-native-$(date +%Y%m%d)"
   ditto "$D" "$X/data" && ditto "$HOME/Documents/cashU" "$X/workspaces"
   diff -rq "$D" "$X/data" && diff -rq "$HOME/Documents/cashU" "$X/workspaces" && echo COPY-OK
   ```
4. **Keep the Python app** so you can roll back:
   `ditto -c -k --keepParent /Applications/cashU.app "$X/cashU-python.zip"`.
5. **Free space**: at least twice `du -sh "$D/cashu.db" "$D/profiles" "$D/imports"` free on the
   data disk (`df -h "$D"`).
6. **Preflight check of the data folder** (prints nothing when the importer will accept it):
   ```sh
   ls -A "$D" | grep -vxE 'cashu\.db(-wal|-shm|-journal)?|finanse\.db(-wal|-shm|-journal)?|profiles|imports|market|(api-token|app-location\.json|desktop\.json|settings\.json|rename-migration\.json)(\.tmp)?|eb_sessions\.json|enablebanking_private\.pem|legacy-migration\.json|cashu\.db\.migrating(-wal|-shm|-journal)?|MIGRATED_FROM\.txt|\.env|worker|mcp|connectors|backups|locks|logs|tmp|run|diagnostics|desktop-electron|bin|update-main-capability\.json|update-preferences\.json|\.DS_Store'
   ls -A "$D/market" 2>/dev/null | grep -vxE 'calendar\.(json|tmp)'
   test -e "$HOME/Library/Application Support/finanse" && echo "STOP: pre-rename folder present"
   ```
   Anything printed is a stop: an entry the importer does not know, which it refuses with
   `semantic_difference` (nothing changes). Do not move it by hand; ask first. A leftover pre-rename `finanse` folder with a database would
   keep the native app on its recovery screen even after the import; ask before touching it.

## 4. Cutover checklist

1. **Quit the Python app** (Cmd+Q) and close every Claude Code session that uses `cashu-profile-a` or
   `cashu-profile-b` (their MCP servers write to the database). Check:
   `pgrep -fl 'Contents/MacOS/cashu( |$)'` prints nothing.
2. **Unload the Python worker agent** (and the pre-rename one, if present):
   ```sh
   launchctl bootout gui/$(id -u)/io.utopiasoft.cashu.worker
   rm -f ~/Library/LaunchAgents/io.utopiasoft.cashu.worker.plist
   launchctl bootout gui/$(id -u)/io.github.synszakala.finanse.worker 2>/dev/null
   rm -f ~/Library/LaunchAgents/io.github.synszakala.finanse.worker.plist
   ```
   Check: `launchctl list | grep -E 'cashu|finanse'` prints nothing and
   `ls ~/Library/LaunchAgents | grep -E 'cashu|finanse'` prints nothing. This matters: the native
   executable `Contents/MacOS/cashU` has the same name as the Python `cashu` on a case-insensitive
   disk, so a leftover agent would call the native app every day (it refuses any command argument
   with exit code 64 and opens no window, but the agent would keep failing).
3. **Remove the Python MCP registrations** for the same reason. Note the scope and slug first:
   ```sh
   claude mcp get cashu-profile-a      # args end in: mcp --profile profile-a ; note the scope
   claude mcp get cashu-profile-b
   claude mcp remove cashu-profile-a -s <scope>
   claude mcp remove cashu-profile-b -s <scope>
   ```
   Check: `claude mcp list | grep cashu-` prints nothing.
4. **Make the copies of section 3** (steps 3.3 and 3.4) now, with everything quit.
5. **Install the native app**: replace `/Applications/cashU.app` with the native bundle (Finder asks
   to replace). Check:
   ```sh
   defaults read /Applications/cashU.app/Contents/Info.plist CFBundleIdentifier   # io.utopiasoft.cashu.next
   ls /Applications/cashU.app/Contents/Frameworks | grep -i sparkle                # prints nothing
   ```
6. **Run the preflight check** (step 3.6) once more. It must print nothing.
7. **Import**, either in the app (section 4a) or in the terminal (section 4b). Not both.

### 4a. In the app

1. Open cashU. It shows "cashU nie może się uruchomić" / "cashU cannot start" with code
   `python_data_present`.
2. Press "Zaimportuj moje dane" / "Import my data". The stages run: "Sprawdzanie danych",
   "Kopiowanie danych", "Importowanie", ... ("Checking the data", "Copying the data", "Importing").
3. "Zapisz frazę odzyskiwania" / "Save your recovery phrase": write the 24 words on paper, check
   them twice, tick "Zapisałem lub zapisałam frazę i mogę ją odzyskać." / "I saved the phrase and can
   retrieve it.", then "Kontynuuj import" / "Continue the import". "Anuluj import" creates nothing.
4. After "Przełączanie na nowe dane" / "Switching to the new data" the app opens normally.
5. Quit cashU fully before step 5.1 (verification needs the data folder lock).

### 4b. In the terminal

Quit cashU first. The recovery file must not exist yet, must be outside `$D`, and its folder must
be a real (non-symlinked) path:

```sh
"${CASHU[@]}" migrate --recovery-file "$HOME/cashU-recovery-words.txt"
```

It prints each stage, then the counts and the backup folder, then "Check the import with: cashu
migrate verify". Exit code 0 means done. Run again on an imported folder (with or without
`--recovery-file`), it only says the folder was already imported and exits 0. Copy the words to paper, then delete the file
(`rm "$HOME/cashU-recovery-words.txt"`).

## 5. Verification

1. **Re-check the import** before you use the app (app quit):
   ```sh
   "${CASHU[@]}" migrate verify
   ```
   Expect the same counts as the import and exit code 0. It reads only.
2. **Look at the folder**: `ls "$D"` shows `python-backup-<time>`, `migration.json`, `native`,
   `vaults`, `stores` (and `workspace` when a profile had workspace settings) and no `cashu.db`; `cat "$D/migration.json"` shows `"profiles":2,"vaults":2`.
3. **Open the app** and compare net worth per currency for both profiles with step 3.2, in the
   app's overview or with `"$D/bin/cashu" --profile profile-a stats` (and `profile-b`). Never add
   currencies together. Bank and cash balances must match exactly; positions valued with market
   prices may move only by price refreshes after the import.
4. Keep `python-backup-<time>/` until all of section 6 is done and the app has run for a while.

## 6. After the cutover

1. **Launcher and slugs**: `CASHU=("$D/bin/cashu")`; `"${CASHU[@]}" profiles list` shows `profile-a` and
   `profile-b` (the MCP name is `cashu-<slug>`).
2. **MCP registrations** (same scope as noted in step 4.3):
   ```sh
   claude mcp add -s <scope> cashu-profile-a -- "$D/bin/cashu" mcp --profile profile-a
   claude mcp add -s <scope> cashu-profile-b -- "$D/bin/cashu" mcp --profile profile-b
   claude mcp list | grep cashu-      # both connected
   ```
3. **Workspaces** (`~/Documents/cashU/<slug>`, same default path and file names as before):
   ```sh
   "${CASHU[@]}" --profile profile-a workspace update
   "${CASHU[@]}" --profile profile-b workspace update
   ```
   Check that `.mcp.json` now points at the native app, that the `cashu:begin` / `cashu:end`
   sections of `CLAUDE.md` changed and nothing else did
   (`diff -rq "$HOME/Documents/cashU" "$X/workspaces"` lists only managed files), and that your own
   skills under `.claude/skills/` are still there. A workspace in another folder and the
   "routine permissions" opt-in come over with the import (`$D/workspace/v1/<vault>.json`, from the
   Python `profiles/<slug>/workspace.json`), so `workspace update` uses that folder.
4. **Worker**: `"${CASHU[@]}" worker install`, then `"${CASHU[@]}" worker status`.
5. **Strategy**: the import wrote the newest stored version into each vault's strategy files, byte
   for byte. Check the Strategies tab shows the strategy with the same state as in the Python app
   (and the same version number, no new version).
6. **Categorization (G4)**: in the app's classification settings choose the backend again; for
   Anthropic enter the key again (the native app keeps it in its own keychain entry). A non-default
   Ollama URL or model from `$D/python-backup-*/.env` must be set again.
7. **Connectors**: installed connector code and approvals are not imported; bindings are. For each
   connector copy its folder out of `$D/python-backup-*/connectors/` into
   `~/Documents/cashU/<slug>/connectors/`, then `"${CASHU[@]}" connectors add <that folder>` (or
   `connectors catalog add <id>` for a catalog one), approve it in the app and enter its secrets
   again.
8. **Enable Banking**: sessions and keys are not imported. In the app, "Skonfiguruj Enable Banking"
   / "Configure Enable Banking": the application ID and "Wybierz prywatny plik klucza" / "Choose
   private key file" (the `enablebanking_private.pem` from the backup), then "Połącz bank" /
   "Connect bank" for every bank. You give consent again in each bank's own page.
9. **Language**: the app follows the system language; pin it in Settings if you had pinned it.
10. **Sparkle**: the native bundle has no Sparkle and its updater has no release feed configured yet,
    so nothing updates it automatically. Replacing the bundle removed the Python updater. Do not
    publish further Python releases (`scripts/release_macos.sh`); a Python install elsewhere would
    still follow `releases/latest` of the Python feed. The native app's version starts at 0.5.0,
    above the last Python release (0.4.6), so any later version comparison between the two orders
    them correctly.
11. **Old keychain items** (service `cashu`: `anthropic`, `connector/...`; legacy service `finanse`)
    stay untouched and unused. Remove them only after you are sure you will not roll back.

## 7. Troubleshooting

Every start-up or import failure shows the recovery screen with a code, whether your original files
are untouched, and "Kopiuj prompt dla agenta" / "Copy prompt for agent". The same prompt is in
`$D/diagnostics/startup-failure-<time>.txt`, its validated form in `startup-failure-<time>.json`,
and the latest typed record in `$D/diagnostics/startup-failure.json`. None of them holds amounts,
account numbers, names or the recovery words; paste the prompt to your agent. Never edit, move or
delete files in `$D` by hand while you troubleshoot.

| Code | Meaning | What to do |
|---|---|---|
| `python_data_present` | Python data, not imported yet | Section 4a or 4b |
| `migrate_import_failed` | The import stopped before the switch; nothing changed. Detail: `source_changed` (something wrote to the Python files: app, worker or MCP still running), `semantic_difference` (an unclassified entry, see step 3.6, or an unreviewed difference), `unsupported_schema` (step 3.1), `cancelled` (words not confirmed), `already_migrated`, `python_data_absent`, `native_host_lock_required` (cashU or a host is running), `source_unsafe` (permissions, links), `staging_failed`, `keystore_unavailable` | Fix the cause, run the import again |
| `migration_incomplete` | The switch was interrupted (`cutover_failed`); the originals are in place or intact in the backup | Run `"${CASHU[@]}" migrate` again; it finishes from the journal |
| `migrate_verify_mismatch` | The imported data does not match the copy of the Python data | Keep the backup, use nothing, send the report |
| `native_inventory_unavailable` | The list of vaults does not match the files | Send the report; do not create a new profile |
| `vault_key_unavailable` | A vault key is missing from the keychain or unreadable | Unlock the login keychain, retry; else send the report. Recovery words restore the keys |
| `view_rebuild_failed` | The data view could not be rebuilt; the history is untouched | Retry; else send the report |
| `unknown` | No known cause; nothing is promised | Work on a copy of `$D`, send the report |

## 8. Completeness: every piece of Python state

Tests are in `apps/host/src/migration/` (host) or `packages/store/src/genesis/` (store) unless the
path says otherwise.

| Python state | How it comes over | Evidence |
|---|---|---|
| 35 financial and agent tables of both profiles (profiles, profile_modules, accounts, balances, transactions, category_rules, import_batches, loans, depreciations, asset_details, inv_account_settings, inv_import_batches, inv_transactions, inv_position_snapshots, inv_instrument_renames, inv_manual_valuations, inv_instruments, inv_instrument_aliases, inv_profile_instruments, inv_strategy_versions, inv_theses, inv_topic_theses, watchlist_items, alerts, inv_planned_deposits, inv_signals, inv_rule_runs, inv_decisions, inv_decision_signals, inv_notification_log, research_runs, research_notes, reviews, proposals, connector_bindings) | Genesis events into one encrypted vault per profile | store `genesis.test.ts` "exports both profiles by ordinal, every event valid, every DET gid from its parts", "folds into fresh stores: nothing parked, view rows equal the source (spec 8.4)", "keeps the profiles apart: no gid or value of one vault in the other"; store `verification/source.test.ts` "refuses a new financial column before any mapping can omit it"; host `oneShot.test.ts` "imports an offline synthetic Python directory into fresh encrypted vaults and re-verifies" |
| inv_decision_signals | Embedded in each decision | store `verification/source.test.ts` "covers embedded decision links and refuses cross-profile links" |
| inv_price_bars, inv_fx_rates, inv_macro_bars | Device store cache, checked by content | store `verification/sourceCache.test.ts` "retains nullable fetch times, all FX bases and macro rows, and detects equal-count edits"; host `localState.test.ts` "hydrates, reopens and compares exact offline cache and device-local history" |
| Global instruments and aliases without a profile | Device store catalog | store `verification/sourceGlobal.test.ts` "checks exact per-vault closure, aliases and unreferenced catalog count" |
| inv_notification_log, connector fetch state (`connector_bindings` last_run_at, last_status, last_ok_at, backoff_until) | Device-local history | store `verification/sourceDeviceLocal.test.ts` "compares notification delivery and connector fetch state field by field"; host `localState.test.ts` (as above) |
| mcp_calls | Device store audit, mapped to the new vault | store `verification/source.test.ts` "accepts exact profile-bound MCP audit history and refuses orphaned audit rows"; host `localState.test.ts` |
| connector_runs | Device store run history | store `verification/source.test.ts` "accepts unscoped connector run history while refusing an unknown named profile"; host `localState.test.ts` |
| connectors (installed catalog, approvals) | Not imported by design: reinstall and approve | store `verification/source.test.ts` "classifies installed Python connector metadata without trusting its approval"; step 6.7 |
| change_events | Not imported by design (one-day live refresh history) | store `verification/source.test.ts` "accepts exact ephemeral change history even with a stale profile and refuses schema drift" |
| sync_ids, sync_vaults, sync_outbox, sync_inbound, sync_clock | Must be empty (Python sync was never enabled in the app); a database that already synced is refused | store `source.test.ts` "refuses sync state on 0029 (sync_ids, sync_vaults, unacked outbox), naming counts only" |
| alembic_version | Schema gate 0025 to 0030 | host `accounting.ts` `SCHEMAS`; store `source.test.ts` "refuses a database without alembic_version, or with two rows"; step 3.1 |
| `profiles/<slug>/budget.json` (cushion) | Genesis event | store `files.test.ts` "parses like Python: decimals quantized to 0.01, currency stripped and upper-cased, ids deduplicated" |
| `profiles/<slug>/strategy.yaml`, `strategy.md` | Checked equal to the newest stored version (else refused); versions imported; the newest version's texts written byte for byte into `vaults/<vault>/strategy/` (where the native app reads them) and read back through the native reader by the import's verify and `migrate verify`; a profile without versions gets an empty folder | store `files.test.ts` "compares both files with the latest version's texts, bytes as UTF-8"; host `accounting.test.ts` "accepts only source-audited successful normalization counts"; host `inPlace.test.ts` "writes the newest strategy version into the vault's strategy files, byte for byte" (and the empty folder in every other `inPlace.test.ts` case); step 6.5 |
| `profiles/<slug>/workspace.json` (custom workspace folder, routine-permissions opt-in) | Converted to the native `workspace/v1/<vault>.json` and checked by verify; the original moves intact to the backup. Read as Python does (unreadable or no folder: defaults, no native file); a value the native file cannot hold (opt-in without a folder, a relative folder) refuses the import | host `inPlace.test.ts` "moves every other device-local Python entry intact into the backup and imports none of it"; `publication/workspace.test.ts`; step 6.3 |
| `imports/<slug>/` archives and staged proposal files | Encrypted native blobs, re-read by `migrate verify` | host `stagedBlobs.test.ts` "collects exact staged and archived bytes for their mapped fresh vault"; `oneShot.test.ts` |
| `market/calendar.json` | Device store calendar cache | host `sourceSeal.test.ts` "seals only the known market calendar cache and refuses extra market files"; `localState.test.ts` |
| `cashu.db-wal`, `-shm`; legacy `finanse.db` | Sealed with the database; offline snapshot | host `sourceSeal.test.ts` "seals DB, WAL, SHM and nested side files without changing source bytes"; `nativeSnapshot.test.ts` |
| `settings.json` (language) | Moved to the backup; the app follows the system language | host `sourceSeal.test.ts` "omits approved process and bank-consent files from the financial copy"; `inPlace.test.ts` "imports in place, keeps the originals intact in the backup, opens normally and is a no-op twice"; step 6.9 |
| `desktop.json` (window), `app-location.json`, `rename-migration.json`, `api-token` | Moved to the backup, not needed (the native window token is per launch, never on disk) | host `inPlace.test.ts` "moves every other device-local Python entry intact into the backup and imports none of it" |
| `eb_sessions.json`, `enablebanking_private.pem` | Moved to the backup, not imported: re-consent | host `sourceSeal.test.ts` "omits approved process and bank-consent files from the financial copy"; step 6.8 |
| `connectors/` (installed code) | Moved to the backup: reinstall and approve | host `inPlace.test.ts` (fixture `connectors/sample`); step 6.7 |
| `logs/` | Moved to the backup; native logs continue in a fresh `logs/` | host `inPlace.test.ts` "imports in place, ..." (`logs` empty after the switch) |
| `backups/` (Python DB copies) | Moved to the backup untouched | host `inPlace.test.ts` (fixture `backups/`) |
| `locks/`, `tmp/` | Moved to the backup | host `inPlace.test.ts` "moves every other device-local Python entry ..." |
| `worker/` (digest dates, bank sync throttle, worker ownership) | Moved to the backup, not imported: the native worker keeps its own bookkeeping (worst case one repeated digest) | host `sourceSeal.test.ts` "classifies every other top-level entry the Python app writes and seals none of it"; `inPlace.test.ts` "moves every other device-local Python entry ..." |
| `mcp/payee.key` (MCP payee pseudonym key), `legacy-migration.json` (`cashu migrate-data` marker), `MIGRATED_FROM.txt` (finanse to cashU move note), `.env` (classifier settings, G4) | Moved to the backup, not imported | as `worker/` |
| Crash leftovers of Python writes: `api-token.tmp`, `app-location.json.tmp`, `desktop.json.tmp`, `settings.json.tmp`, `rename-migration.json.tmp`, `cashu.db.migrating` (with `-wal`, `-shm`, `-journal`), `market/calendar.tmp` | Moved to the backup, never read (Python does not read them either) | as `worker/` |
| Any other top-level entry | Refused (`semantic_difference`), nothing changes | host `sourceSeal.test.ts` "refuses an unclassified root-level entry"; `inPlace.test.ts` "refuses without touching anything: no Python data, unknown entries, a running host"; step 3.6 |
| Classifier backend, Ollama URL and model (`.env` / environment), Anthropic key (keychain `cashu` / `anthropic`) | Not imported (G4) | step 6.6 |
| Connector secrets (keychain `cashu` / `connector/<id>/<slug>/<binding>/<secret>`) | Not imported | step 6.7 |
| Agent workspaces `~/Documents/cashU/<slug>` (CLAUDE.md, AGENTS.md link, `.claude/skills`, `notes/`, `research/`, `inbox/`) | Outside the data folder, untouched; same default path, markers, folders and manifest name `.claude/cashu-workspace.json` in the native app | step 6.3 |
| Research notes | Database rows (research_notes, research_runs): genesis | as the 35 tables |
| Enabled modules per profile, base currency, MCP privacy | profiles, profile_modules: genesis | as the 35 tables |
| Python worker launch agent `io.utopiasoft.cashu.worker` (legacy `io.github.synszakala.finanse.worker`) | Removed by hand; native host agent `io.utopiasoft.cashu.next.host` | step 4.2, 6.4 |
| MCP registrations `cashu-profile-a`, `cashu-profile-b` | Removed and added again against `$D/bin/cashu` | step 4.3, 6.2 |
| Sparkle (Python bundle `io.utopiasoft.cashu`, feed `releases/latest/download/appcast-macos-<arch>.xml`) | Gone with the Python bundle; native bundle `io.utopiasoft.cashu.next` has no Sparkle | step 4.5, 6.10 |
| `statements/` CSV drop folder | Only in a source checkout, never in the data folder: nothing to carry | - |
| LLM caches | None on disk: categorization results are transaction and rule rows | as the 35 tables |
