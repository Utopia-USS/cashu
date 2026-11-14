# Running, demo data, e2e and packaging

What this is: how to run and verify the app locally on a synthetic demo, run the checks and the desktop e2e suite, and build a development cashU.app.

## How to use this

The command list is in [CLAUDE.md](../../CLAUDE.md) "Common commands"; this file carries the caveats
behind them. Everything here runs on synthetic data and temp or demo data dirs, never the owner's
real data dir.

## Workspace checks

Run from the repo root with Node >=24 (`.nvmrc`, the Node of Electron) and the pnpm version pinned in `package.json`
(`corepack enable`). The pnpm workspace is `packages/*`, `apps/*` and `tools/arch`.

Since M3 the store needs SQLite with FTS5 (the budget search index). `node:sqlite` has it from Node 24
(the `.nvmrc` Node, also Electron 45's), not in Node 23; `better-sqlite3` (the tests' driver) and
expo-sqlite (the phone) ship their own SQLite with it. On an older Node the dev host, the CLI from
source and the host tests stop at the first store open with "node:sqlite has no FTS5 (Node vX.Y.Z);
cashU needs Node >= 24 (.nvmrc) or Electron's Node" (`MissingFts5Error`, `packages/node-host/src/nodeSqlite.ts`).

| Task | Command |
|---|---|
| Install locked dependencies | `pnpm install --frozen-lockfile` |
| Typecheck / lint / default tests | `pnpm typecheck`, `pnpm lint`, `pnpm test` (together: `pnpm check`) |
| One package | `pnpm --filter @cashu/<name> test` (or `typecheck`, `lint`) |
| Exhaustive tests (serial packages) | `pnpm test:exhaustive`; one package: `CASHU_TEST_TIER=exhaustive pnpm --filter @cashu/<name> exec vitest run` |
| Architecture checks | `pnpm arch:check` (Biome lint, ESLint react-hooks, dependency-cruiser, Knip, sherif, the guards) |
| Complete handoff gate | `pnpm check:handoff` (default checks, exhaustive tests, architecture) |
| Generated files | `pnpm --filter @cashu/host gen:connector-schemas --check`, `pnpm --filter @cashu/host skills:sync --check` |
| Mobile | `pnpm --filter @cashu/mobile ios` / `android` (local dev client), `pnpm --filter @cashu/mobile start` (bundler), `pnpm bundle:check` |
| Sync relay against the emulator | `pnpm test:emulator`: starts the Firestore and Auth emulators (`firebase emulators:exec`, project `demo-cashu`, offline, nothing deployed) and runs the emulator suites with the real `firestore.rules`. Needs Java 21+ and firebase-tools (`npm install -g firebase-tools`, or `CASHU_FIREBASE=<command>`) |

CI (`.github/workflows/ts.yml`) runs install, `turbo run typecheck lint`, `pnpm test` (4 packages at once), the exhaustive tier,
`arch:check` and the mobile bundle check on Linux and macOS, and in a separate `emulator` job (Linux, Java 21,
firebase-tools pinned through `CASHU_FIREBASE`) `pnpm test:emulator`. The emulator test files skip themselves in
`pnpm test`, and the in-memory Firestore fake applies no rules, so only that job tests the security rules.

## Desktop app on a synthetic demo

```bash
pnpm --filter @cashu/desktop dev
```

`apps/desktop/scripts/dev.mjs` builds the desktop app, seeds a synthetic demo the first time
(`apps/host/src/testing/devDemo.ts`: native vaults, no Python, no OS keychain, no network), starts that
data dir's host, waits until it is ready and launches Electron against it; it stops the host when
Electron exits.

| Fact | Detail |
|---|---|
| Data dir | `CASHU_DATA_DIR`, default `~/cashu-lab/desktop-demo`; a dir without the demo marker (`dev-demo.json`) is refused |
| Workspaces | `CASHU_WORKSPACES_DIR`, default `~/cashu-lab/desktop-demo-ws` |
| Allowed root | `CASHU_DESKTOP_ALLOWED_DATA_ROOT`, default `~/cashu-lab`: the shell refuses a data dir outside it |
| Demo content | `demo-anna` (budget with a EUR account, assets, loans, investments) and `demo-piotr` (budget, investments without holdings); six months of seeded data dated relative to today, invented names and IBANs |
| Fresh demo | delete the data dir and run the command again |
| A host left running | `node --experimental-strip-types --import ./tools/node-ts/resolveTs.ts apps/host/src/cli.ts stop --data-dir <dir>`, or `pnpm cashu-next host stop` with that `CASHU_DATA_DIR`; a host exits on its own after 10 idle minutes |

### Phone against the emulator

To pair the iOS simulator with a desktop demo without a real Firebase project, run both against the
local emulator (`firebase.json`: Firestore 8080, Auth 9099, project `demo-cashu`):
`firebase emulators:start --only firestore,auth --project demo-cashu`; the host gets
`CASHU_FIRESTORE_EMULATOR_HOST=127.0.0.1:8080` and `CASHU_FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099`
(`apps/host/src/relay/config.ts`), the phone's dev build gets `EXPO_PUBLIC_FIRESTORE_EMULATOR_HOST` and
`EXPO_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` with the same values (in the environment of `expo start`, or in
`apps/mobile/.env.local`; template `apps/mobile/.env.example`). With no project variables both use
`demo-cashu`. The emulator keeps no data after it stops (`firebase.json` configures no import or export).
Start the desktop with the two `CASHU_*` variables in the environment of
`pnpm --filter @cashu/desktop dev` (`apps/desktop/scripts/dev.mjs` passes its environment to the host), switch
sync on for a demo profile in Settings > Devices, open "Pair a phone" > "Create invitation" and scan the QR in the
simulator (or "Copy code" and paste it on the phone), then type the phone's six digits on the Mac. How it works:
[sync-and-mobile.md](sync-and-mobile.md).
A release build ignores the emulator variables; a real project goes in the four plain
`EXPO_PUBLIC_FIREBASE_PROJECT_ID` / `_API_KEY` / `_APP_ID` / `_AUTH_DOMAIN` variables (unquoted: Expo's
`.env` parser cuts a double-quoted value at its first quote, so the older JSON `EXPO_PUBLIC_FIREBASE_CONFIG`
in quotes arrives as `{\`). Restart Metro with `--clear` after changing them: they are inlined at bundle time.

## The `cashu` command from a checkout

`pnpm cashu-next <command>` runs the shim (`apps/cli/src/index.ts`) from source, e.g.
`pnpm cashu-next --help` or `pnpm cashu-next --profile demo-anna stats`. It talks to the host of the
resolved data dir and starts one when none runs. The data dir comes from `CASHU_DATA_DIR`, else the
git-ignored `.env.dev` at the checkout root (also read by every git worktree of it;
`apps/cli/src/devenv.ts`: only `CASHU_*` keys, the shell always wins, never read when packaged or
under `CASHU_TESTING`), else the per-user data dir. Keep a `.env.dev` in every dev checkout so it never
lands on real data:

```bash
printf '%s\n' "CASHU_DATA_DIR=$HOME/cashu-lab/desktop-demo" "CASHU_WORKSPACES_DIR=$HOME/cashu-lab/desktop-demo-ws" > .env.dev
```

## Desktop e2e (`apps/desktop/e2e/`)

| Fact | Detail |
|---|---|
| Runner | Playwright test runner driving the built Electron app, one worker, specs in order |
| Build | it never builds: run `pnpm --filter @cashu/desktop build` first (global setup fails without `dist/main.js` and `dist/renderer/index.html`) |
| Global setup | a temp root with `CASHU_TESTING=1`, a temp `HOME`, `CASHU_DATA_DIR`, `CASHU_WORKSPACES_DIR` and `TMPDIR`, `TZ=Europe/Warsaw`; seeds the demo with `apps/host/src/testing/seedOverviewDemo.ts`; removes everything afterwards (`E2E_KEEP=1` keeps it) |
| Specs | `apps/desktop/e2e/desktop-specs/` |
| Artifacts | `apps/desktop/dist/e2e-run/results` (git-ignored) |
| Run all | `pnpm --filter @cashu/desktop build && pnpm --filter @cashu/desktop e2e` |
| One spec | `pnpm --filter @cashu/desktop e2e <spec name filter>` |

When you change UI copy or structure, keep the specs on roles, labels and aria names rather than long
texts, and update the matching spec in the same change.

## Packaging

```bash
node apps/desktop/scripts/package-macos.mjs arm64      # or x64; --dmg adds a disk image
```

It builds the desktop app (`--reuse-desktop` skips that), bundles the host (`host.mjs`) and the
`cashu` shim (`shim.mjs`), builds the native helpers, copies the shipped skills (`.claude/skills`) and
the connector catalog (`connectors/`) into the app's Resources, runs electron-builder
(`apps/desktop/build/electron-builder.config.cjs`), signs ad hoc, writes the bundle manifest and
verifies the package (`verify-package.mjs`). Output: `build/t46/electron-builder/mac-arm64/cashU.app`
(`mac/` for x64) and `build/t46/cashU-<version>-mac-<arch>.zip` (`.dmg`). Every build seals
`Contents/Resources/app-update.yml` from the policy pinned in `apps/desktop/src/update/releasePolicy.ts`.

This is the development build (ad hoc signed): it opens on the Mac that built it and reports updates
unavailable. Releases are never made from it by hand: the release script
(`apps/desktop/scripts/release-macos.mjs`, run by `.github/workflows/release-macos.yml` after the version
bump on `main`, or by the owner as a fallback) calls `package-macos.mjs <arch> --sign <Developer ID>
--notarize <profile> --dmg` once per arch (Developer ID, hardened runtime, notarized and stapled, release
entitlements `apps/desktop/build/entitlements.release.mac.plist`) and verifies every artifact with
`verify-package.mjs --release --notarized`. Procedure: [releasing.md](../releasing.md); the update
contract inside the app: [s47-update-operator.md](s47-update-operator.md). The owner's local
`cashU Staging` app (`--flavor staging`) is described in [releasing.md](../releasing.md) "Staging build".

An installed app's CLI is the bundled shim run by the app binary in Node mode, reached through the
launcher the host writes at every start:

```bash
"$HOME/Library/Application Support/cashU/bin/cashu" --help
ELECTRON_RUN_AS_NODE=1 /Applications/cashU.app/Contents/MacOS/cashU /Applications/cashU.app/Contents/Resources/shim.mjs --help
```

Never run either against the owner's installed app or real data dir from a dev session.

## See also

- [conventions.md](conventions.md) - test rules (synthetic data, temp data dirs, test key store)
- [extending.md](extending.md) - what to verify after each kind of change
