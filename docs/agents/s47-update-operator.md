# S47 Electron update operator notes

Status: the release path is built and proven up to the first publication (2026-11-07): a full signed and
notarized dry run of both arches and an in-place update 0.5.0 -> 0.5.1 of a Developer ID signed test build.
The signed CI path is unproven until its first run. How to release: [docs/releasing.md](../releasing.md);
the evidence boundary is at its end. This file is the contract inside the app.

## Release inputs

- Build the macOS zip and dmg with the fixed `io.utopiasoft.cashu` bundle ID, `cashU` executable and sealed `Contents/Resources/app-update.yml` generic HTTPS feed. The feed belongs to the signed build. Renderer commands cannot set it.
- `RELEASE_TEAM_ID` (`29W838VKU4`) and `RELEASE_FEED_URL` (`https://github.com/Utopia-USS/cashu/releases/latest/download/`, the GitHub Releases of Utopia-USS/cashu) are pinned in `apps/desktop/src/update/releasePolicy.ts`. The package step writes `app-update.yml` from that file (`apps/desktop/scripts/release-policy.mjs`), so the compiled gate and the sealed feed cannot disagree; `verify-package.mjs --release` checks both. Ad-hoc builds carry the same feed but fail the Developer ID requirement and report updates unavailable.
- Keep one Developer ID Team ID across installed builds. Verify the app inside the downloaded zip under the release signing identity before owner-controlled publication. The macOS updater's Squirrel installation also checks matching signing identity.
- Produce update metadata with the zip checksum. Keep the endpoint and archive immutable after publishing. Source tests with a local generic HTTP server and synthetic archives do not prove release trust.
- Releases are built by `apps/desktop/scripts/release-macos.mjs` (the CI workflow `release-macos.yml` after the version bump on `main`, or the owner's local fallback), which calls `package-macos.mjs <arch> --sign ... --notarize ... --dmg` per arch, verifies every artifact with `verify-package.mjs --release --notarized` and publishes 7 assets: both zips and dmgs, `latest-mac.yml` (both zips; electron-updater picks the `arm64` one on Apple silicon, `controller.ts` accepts one or two zips) and the informational Sparkle appcasts for the retired Python app (`appcast-macos-arm64.xml`, `appcast-macos-x86_64.xml`). A plain `package-macos.mjs <arch>` build is ad hoc, for development only.

## Test builds (local update proofs)

- `package-macos.mjs <arch> --sign "..." --test-build '<json>' [--app-version X.Y.Z]` seals `Contents/Resources/test-build.json` (`{schema: 1, kind: "cashu-test-build", feedUrl: "http://127.0.0.1:<port>/", installRoot, dataDir, workspacesDir}`, listed in `bundle-manifest.json`) and an `app-update.yml` naming that local feed with the `cashu-updater-test` cache. `--app-version` changes only the test build's version (electron-builder extraMetadata), never `package.json`.
- The app honors the marker only when its bytes match the verified bundle manifest (`packages/node-host/src/testBuild.ts`): main accepts the local feed (`parseTestBuildFeed`), the install root instead of `/Applications` and runs on the marker's data dir (also when ShipIt relaunches it without environment; another explicit `CASHU_DATA_DIR` is refused); the window title reads "cashU - TEST BUILD"; the host maps every OS keyring service into `cashu-next-test.<hex>` (`keyring/native.ts`), keeps workspaces in `workspacesDir` and runs `migrate` only into the marker's data dir (`migratesOnlyInto`, for the synthetic Python import smoke test), where the Python agents are retired only from an explicit `CASHU_LAUNCH_AGENTS_DIR` and launchctl never runs (`pythonAgents.ts`). Without the marker every path is the release one.
- A release never carries it: `verify-package.mjs --release` (run by the release script on every artifact) calls `assertNoTestBuild` first; `--test-build` runs the same Developer ID checks for a test build.
- CI notarization: `--notary-key <AuthKey.p8> --notary-key-id <id> --notary-issuer <uuid>` instead of `--notarize <profile>`, and `--keychain <path>` for codesign from a temporary keychain.

## Automatic check

- `apps/desktop/src/update/schedule.ts`: Electron main starts it after `desktop.start` only when the
  controller's gate passed and the update bridge to the host runs (an installed release, or a sealed
  test build on its local feed). One check 90 s after start, then hourly ticks that check again once
  24 h of wall-clock time passed since the last check that reached the feed (a sleeping Mac checks at
  the next tick). Dev, tests, e2e, unsigned, ad-hoc and staging builds never start it, and
  `controller.checkAutomatically` refuses without the gate anyway.
- The toggle "Sprawdzaj codziennie" / "Check daily" (Settings > Aplikacja) is `auto` in
  `update-preferences.json`, default on when the file is absent: it turns the automatic check on or off
  and nothing else. Mirrors the retired Python app's Sparkle (`SUEnableAutomaticChecks` true,
  `SUAllowsAutomaticUpdates` false): an automatic check never downloads or installs; there is no
  automatic install. The switch shows `updateStatus.autoCheck` (main's file is the only source).
- An automatic check runs only when no action is busy and no found version is visible, downloading,
  downloaded or installing. Its checking, up-to-date and error stages show no card
  (`updateStatus.manualCheck` false); a found version shows the same corner card as a manual find
  (`UpdateNotice`, mounted once in the profile shell), honouring "Pomiń" (skip) and "Przypomnij
  później" (dismiss) per version. "Aktualizuj" makes the cycle manual again, so its download and install
  stages report in the card.

## Install sequence

1. Main rechecks the packaged app's canonical path, bundle ID, release signature, fixed feed config, expected data directory and install location. Translocated, unsigned, ad-hoc, moved or ambiguous apps report unavailable/refused.
2. Main checks and downloads through electron-updater. Metadata without a zip checksum is refused; download is not treated as ready until `update-downloaded` confirms the same version. Skip, dismiss and auto preferences live in a private device-local file.
3. The host reaches main through a private, typed local capability socket tied to one main session, build and verified bundle fingerprint. Install admission returns `outcome_unknown/install_scheduled` before main asks the host to hand over, so the host action can finish before its drain. This means the request was accepted for an attempt, not that an update installed. Disconnect or timeout is unknown and is never retried automatically.
4. Before `quitAndInstall`, main publishes a durable prepared update admission barrier, stops new work, requests `admin.handover`, waits for the host's native write and sync drain, acquires the HostLock after the old host releases it. Main retains the lock and barrier through install dispatch. A final identity check runs while the lock is held. Only a durable `dispatch_committed` marker permits `quitAndInstall`; an uncertain marker write blocks installation and keeps the barrier. A proved prepared state may be cancelled before dispatch.
5. The host verifies every listed bundle resource hash at startup and watches its original `.app` path, Info.plist, executable and bundle manifest. On a move, disappearance or replacement it drains and exits 75. It does not start code from the replacement itself. The new app must reacquire the lock and verify identity.
6. A moved app may leave stale service or MCP registration paths. Surface the existing `app-location.json` warning and require explicit repair; never rewrite OS registration implicitly.

## Evidence boundary

An isolated ad-hoc fixture proves files, app identity, host launch and mocked updater state only. The release evidence (what the dry run, the test-build update and the Python Sparkle proof showed, and what stays unproven: the signed CI path, retiring the real Python agent labels, the Intel update end to end) is listed in [docs/releasing.md](../releasing.md) "Evidence boundary". Never operate on `/Applications/cashU.app` or real profile data while testing updates: use a test build.

References: [electron-builder v26 auto update](https://www.electron.build/v26/docs/features/auto-update/), [electron-builder macOS](https://www.electron.build/v26/docs/mac/).
