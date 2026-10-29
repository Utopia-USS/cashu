# Packaging notes (cashU.app)

Build: `scripts/build_macos.sh` (see its header for options and signing variables). This file
records the decisions behind the signing and build inputs.

## Build dependencies: `requirements-build.lock`

The build venv is installed only from `requirements-build.lock`: every package (runtime
dependencies with the `desktop` extra, PyInstaller, the hatchling build backend, pip and setuptools)
at an exact version with sha256 hashes, `pip install --require-hashes --no-deps`. cashU itself is
installed editable with `--no-deps --no-build-isolation`, so nothing unpinned is downloaded while
building a bundle that gets signed with the owner's Developer ID. The npm side uses `npm ci`
(lockfile integrity hashes).

Regenerate after changing `pyproject.toml`, `constraints.txt` or `requirements-build.txt`
(from the repo root, with pip-tools in any scratch venv, on macOS with the build's Python):

```bash
pip-compile --generate-hashes --allow-unsafe --strip-extras --extra desktop \
  -c constraints.txt -o packaging/requirements-build.lock \
  pyproject.toml packaging/requirements-build.txt
```

Keep `PIP_VERSION` in `scripts/build_macos.sh` equal to the `pip==` pin (the script refuses
otherwise). `tests/test_fxp_packaging.py` checks the lock is fully hashed.

## Entitlements

`entitlements.plist` holds the hardened-runtime exceptions of the Developer ID build: currently
none (an empty dict; the hardened runtime itself stays on).

Removed in F7 (PK4):

| entitlement | why it is not needed |
|---|---|
| `com.apple.security.cs.disable-library-validation` | The script re-signs every Mach-O file in `Frameworks/` and `Resources/` with the same identity, so library validation passes. It was only needed for ad-hoc + hardened-runtime experiments (ad-hoc code has no Team ID). Granting it would let a dylib or `.so` swapped into the user-writable bundle load into the notarized process. |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Tested 2026-10-05 on arm64 / macOS 15: the unsigned build re-signed ad-hoc with `--options runtime` and only `disable-library-validation` (required for ad-hoc, see above) opened the window, got the token over the pywebview bridge, ran the WebKit navigation delegate and the quit handler (pyobjc callbacks = libffi closures, static trampolines on arm64), `worker run --offline` and `mcp --profile <slug>` (initialize). Not tested on an Intel Mac. |

Checklist for a Developer ID build (run before shipping, and before adding an entitlement back):

1. `codesign -d --entitlements - cashU.app` shows no exception keys.
2. Open the app from /Applications: the dashboard loads (token bridge, navigation delegate), a
   notification click opens the right view, Cmd+Q quits (app.log in debug mode: "Shutting down").
3. `cashU.app/Contents/MacOS/cashu worker run --offline` and
   `cashU.app/Contents/MacOS/cashu mcp --profile <slug>` (Claude Code connects) work.
4. `log show --last 5m --predicate 'process == "cashu"' | grep -i -E "library validation|code signature|killed"`
   is empty. If a step fails with a code-signing or memory error, add back only the entitlement
   named there and record why in this table.

## Bundled Deno (deno connectors)

The app ships the official Deno release binary so a connector written by the user's agent runs
without anything installed (docs/agents/connector-runtime.md). Decisions:

- **Pinned, verified, build-time only.** `scripts/build_macos.sh` step 3b holds `DENO_VERSION` and a
  sha256 per architecture of the official `deno-<target>.zip` from github.com/denoland/deno/releases.
  The archive is downloaded once into the build folder and checked against the pinned sha256 on every
  build, before it is unpacked; the unpacked binary must report that version. The app itself never
  downloads anything. Deno 2.9.1 is pinned (2026-10-30): the GitHub asset digests and the
  release's `.sha256sum` files agreed for both architectures. If the constants are ever emptied
  (a new version not pinned yet), the script builds the app **without Deno** and prints a loud
  warning (start and end of the build; the summary says `deno: NOT bundled`), so the ship step never
  blocks; Deno connectors in such a build fail with "deno was not found" unless the Mac has its own
  deno. `--skip-deno` builds without it on purpose. Pinning a new version: "Pinning the Deno release"
  below.
- **Location.** `packaging/cashu.spec` adds it as a binary in folder `deno/` of the bundle
  (`Contents/Frameworks/deno/deno`), with the MIT license (`packaging/third-party/deno-LICENSE.md`).
  `core/connectors/manifest.py` `bundled_interpreter` prefers it over any `deno` on the search path;
  an app update replaces it at the same path, so approvals that pinned it stay valid.
- **Signing.** The deno binary is signed on its own with `packaging/deno-entitlements.plist`
  (`com.apple.security.cs.allow-jit` only): with the hardened runtime and no JIT entitlement V8
  aborts at start. The main executable keeps `entitlements.plist` (none). The alternative,
  `--v8-flags=--jitless` without the entitlement, was rejected by the owner (slower, no WebAssembly).
- **Confinement does not depend on the signature:** deno connectors run with Deno's permission flags
  inside `sandbox-exec`, after the module-graph check (`core/connectors/sandbox.py`).

### Pinning the Deno release

Do this once per Deno version, on a trusted machine, and commit the result on its own
(`Pin the Deno <version> release`):

1. Pick the version (`DENO_VERSION` in `scripts/build_macos.sh`) on
   https://github.com/denoland/deno/releases and check the release lists `deno-aarch64-apple-darwin.zip`
   and `deno-x86_64-apple-darwin.zip`, each with its `<archive>.sha256sum` file.
2. Download both archives and both `.sha256sum` files into an empty scratch folder:
   `curl -fLO --proto '=https' https://github.com/denoland/deno/releases/download/v<version>/deno-aarch64-apple-darwin.zip`
   (and `.sha256sum`, and the same for `x86_64`).
3. Compute the hashes yourself: `shasum -a 256 deno-*.zip`. Each must equal the value in its
   `.sha256sum` file (the first field).
4. Cross-check from an independent source: the same `shasum` of the archives downloaded on a second
   machine or network, or the asset digests GitHub shows for the release
   (`gh release view v<version> -R denoland/deno --json assets`, field `digest` `sha256:...`, where
   available). All three must agree; if anything differs, do not pin.
5. Unzip the archive of this Mac's architecture and run `./deno --version`: the first line is
   `deno <version> ...`.
6. Put the hashes into `DENO_SHA256_AARCH64` and `DENO_SHA256_X86_64` (64 lower-case hex characters;
   update all three constants together), commit, and run `scripts/build_macos.sh --clean`. The summary
   must say `deno: <version> (bundled)` and print no warning; a mismatching archive stops the build and
   is deleted.
7. With a Developer ID build, `codesign -d --entitlements - cashU.app/Contents/Frameworks/deno/deno`
   shows only `com.apple.security.cs.allow-jit`, and a Deno connector's `test_connector` reports
   `interpreter: deno (bundled with the app)`.

## Auto-update (Sparkle 2)

Status: an update between two ad-hoc builds is verified end to end (offer, download, install, relaunch);
between two Developer ID builds it is not verified yet.

- **Opt-in per build.** `build_macos.sh` bundles Sparkle (release archive pinned by sha256, cached
  in `build/macos/sparkle/`) and writes `SUFeedURL` / `SUPublicEDKey` into Info.plist only when
  `SPARKLE_PUBLIC_ED_KEY` is set. Without it nothing changes. With it the minimum macOS becomes
  12.0 (Sparkle 2.10).
- **Keys.** Once, on the release Mac: `build/macos/sparkle/bin/generate_keys` puts the private key
  into the login keychain and prints the public key, which is what `SPARKLE_PUBLIC_ED_KEY` holds.
  Back the private key up (`generate_keys -x <file>`, stored offline). Losing it means installed
  apps can never update again. Rotating it needs one release signed with the old key that already
  carries the new public key.
- **Signing.** The XPC services are removed (the app is not sandboxed). `Autoupdate`,
  `Updater.app` and the framework are signed inside-out with the hardened runtime and without
  `--deep`, and they are left out of the loose-file loop.
- **Feed.** One appcast per architecture, `appcast-macos-<arch>.xml`, uploaded with the archive to
  the GitHub release `v<version>`. The app reads
  `https://github.com/<repo>/releases/latest/download/appcast-macos-<arch>.xml`, so the newest
  non-prerelease release is what every installed app sees.
- **Release.** Only from the owner's Mac, with `scripts/release_macos.sh` (or the personal
  `cashu-release` skill): it builds `origin/main`, signs, notarizes, signs the update with the key in the
  keychain and publishes an immutable GitHub release. Setup and procedure: [RELEASING.md](RELEASING.md).
- **In the app** (`desktop/updater.py`). Only from `/Applications`, not translocated, not with
  `CASHU_UPDATE_CHECK=0`. Sparkle's windows are replaced by our own `SPUUserDriver`, so the
  dashboard's corner card (`UpdateNotice.tsx`) is the whole UI.
  - Sparkle checks once a day without asking first (`SUEnableAutomaticChecks`). Daily checks can be
    switched off in Settings > Aplikacja.
  - Nothing is downloaded on its own (`SUAllowsAutomaticUpdates` false). A new version waits in
    the card: "Aktualizuj" downloads, verifies and installs it, then relaunches; "Pomiń" means it
    is never offered again; closing the card reminds later.
  - "Sprawdź aktualizacje…" in the app menu and "Sprawdź" in Settings check on demand, and the
    result shows in the same card.
  - Installing replaces the bundle at the same path, so the launchd job and the MCP lines stay
    valid.
- **Old processes.** An MCP server or a worker run started from the replaced copy would run old
  code next to a database the new version may already have migrated.
  `core.runtime.bundle_replaced()` compares the bundle's Info.plist with the one the process
  started with. On a mismatch, the MCP server refuses the next call (before the audit and the
  database), asks to reconnect with `/mcp` and exits. The worker stops before its next job and
  writes no state.
- **Testing a build outside /Applications.** Run
  `CASHU_UPDATER_ANYWHERE=1 CASHU_DATA_DIR=<scratch> <app>/Contents/MacOS/cashu` from a folder you
  own. Keep `CASHU_DATA_DIR` pointed away from the real data dir, and do not install a test build
  over `/Applications/cashU.app`.

## Where the app keeps data

- Data dir: `~/Library/Application Support/cashU` (0700), or `CASHU_DATA_DIR`.
- WebView storage (localStorage: chosen profile, theme, layout, view filters, the review note
  draft): `~/Library/WebKit/io.utopiasoft.cashu/`. pywebview's macOS backend always uses
  WebKit's default data store and ignores `storage_path`, so this cannot live in the data dir. The
  SPA keeps no amounts there (planned deposits are stored on the server). Deleting the data dir
  does not clear it; remove that folder too for a full wipe. The bundle id changed with the rename
  to cashU (legacy name: `io.github.synszakala.finanse`), so the window starts with an empty
  WebKit store once; the old folder can be deleted.
- Before the rename (legacy name: finanse) the executable was `Contents/MacOS/finanse`: launchd
  jobs and MCP lines that name it stop working after the update. The first start of the new app
  reinstalls the background job (core/migrate_legacy.py); MCP lines are fixed by "Aktualizuj
  workspace" or by re-adding them. The legacy name scheme `finanse://` stays registered for links
  in notifications posted before the update.
- `app-location.json` in the data dir: where cashU.app last ran from. After a move or rename
  `cashu worker status` (and the `worker.relocation` object of `GET /api/system`) flags the
  launchd job and the MCP lines given out before as stale; `cashu worker install` is the fix and
  clears the note. Nothing is rewritten automatically.
