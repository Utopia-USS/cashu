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
  downloads anything. The sha256 constants are **empty until pinned**: the script refuses to build
  (or use `--skip-deno` for a local build without Deno). Update the version and both hashes together,
  from the release's `.sha256sum` files, cross-checked against a download on a second machine.
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
