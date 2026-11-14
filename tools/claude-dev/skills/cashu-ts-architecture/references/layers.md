---
title: Layers, modules, exports and processes
impact: CRITICAL
tags: architecture, packages, imports, modules, exports, electron, expo
---

# Layers, modules, exports and processes

## Folder shape

Every package mirrors the product modules of the Python app (`core`, `budget`, `assets`, `loans`,
`investments`), so a feature lives at the same path in every layer:

```
packages/domain/src/<module>/...              pure logic + types
packages/store/src/<module>/events.ts         zod event schemas (v1 under src/events/v1, see spec)
packages/store/src/<module>/materialize.ts    event -> view tables (the only SQL writer)
packages/store/src/<module>/queries.ts        typed read queries
packages/store/src/<module>/commands.ts       input schema + validate -> append events
packages/store/src/query.ts, device/          defineQuery / watchQuery; the device-local store
packages/store-react/src/                     useQuery / useCommand / providers, client (cache, port), host
packages/ui-logic/src/<module>/useX.ts        reusable feature hooks (useUncategorizedMerchants)
apps/mobile/app/...                           Expo Router route files (routes only)
apps/mobile/src/screens/<screen>/             useXScreen.ts, XView.tsx, XView.stories.tsx, X.strings.ts
apps/desktop/src/renderer/routes/...          TanStack Router route files
apps/desktop/src/renderer/screens/<screen>/   same shape as mobile
```

`packages/*/src/<module>/index.ts` is the module's public API; anything it does not export is
private to the module. `packages/*/package.json` `exports` lists the package's public entry points
(`"."`, and subpaths such as `"./investments"`); TypeScript (`moduleResolution: NodeNext`) and every
bundler refuse imports of paths it does not list, so a private file is unreachable from outside.
No wildcard subpaths.

## Allowed imports

The source of truth is `tools/arch/depcruise.config.cjs` (`LAYERS`) with the matching Biome
overrides in `biome.json`; the table in `SKILL.md` mirrors it. Additional rules:

| Rule | Checked by |
|---|---|
| domain imports nothing outside itself (tests and `src/testing/` may use vitest and node) | depcruise `domain-is-pure`, Biome override |
| an app never imports another app | depcruise `apps-are-leaves` |
| other packages by name only, never `../../store/src/...` | depcruise `no-relative-cross-package` |
| module A never imports module B's internals (`index.ts` only), in any package | depcruise `module-internals` |
| `core` never imports a module | depcruise `core-imports-no-module` |
| production code never imports tests, fixtures or test helpers | depcruise `no-test-code-in-prod` |
| no import cycles (type-only edges excepted) | depcruise `no-circular` (full run) |
| a symbol tagged `/** @package */` or `/** @private */` stays in its package / folder | Biome `noPrivateImports` |
| store, store-react, sync, i18n, ui-logic stay platform free (no `node:*`, Electron, React Native, Expo, DOM) | Biome overrides |
| Views and packages/ui never import store-react (`useQuery` / `useCommand` belong in the screen hook) | depcruise `view-is-pure`, `ui-is-pure`, Biome View override |

Need data from another module? Use its public `index.ts`, or move the shared concept to `core`.

## Where does it go?

- A rule that stays the same with a different UI (net worth, transfer matching, a signal) -> `domain`.
- Turning events into rows, or reading rows -> `store` (materializer / query).
- "When the user taps X, record Y" -> a `store` command, called from a screen hook (`useCommand`).
- Live reads in React, the store client and its connection status -> `store-react` (React-free
  subpaths: `./client` for the desktop renderer, which speaks the host's store channel v5
  (`@cashu/host-protocol/store`) through main's relay; `./local` for an in-process engine).
- Device-local app state (current profile, device settings) -> the device store
  (`@cashu/store/device`), read with `useQuery`, written by device commands; never synced.
- A data need two screens (or two platforms) share -> a feature hook in `ui-logic`.
- What one screen shows and does -> its screen hook, next to the screen in the app.
- Pixels -> `packages/ui` (shared) or the View (one screen's composition).
- Process, window, notifications, keychain, file system -> the app.
- Market data from the network -> parsing, planning and the price cache contract in `domain` (`investments/market/`), the HTTP sources (injected `fetch`, leader only) in `packages/market`.

## Platform code

`domain`, `store`, `sync`, `i18n`, `ui-logic` run on Node, the Electron renderer and Hermes. Platform
needs come in through interfaces wired at the app root: `SqlDriver` (better-sqlite3 / node:sqlite on
desktop, expo-sqlite or op-sqlite on mobile), `KeyStore`, `Transport`, `Clock`.

## Which process runs what

Target (S56 design, owner decision: host on demand with idle linger and a daily wake, macOS 13+): one
local host process per data dir is the only process that opens a vault store; everything else is a
client over an authenticated Unix socket (`@cashu/host-protocol`, platform glue in `@cashu/node-host`).

| Process | Runs | Talks to |
|---|---|---|
| Local host (`apps/host`, S56a2; one per data dir, started on demand by its first client, lingers when idle) | holds the machine lock (`run/host.lock.db`) for life; vault and device stores (exclusive SQLite open that requires the lock), materializer, sync, the worker, MCP sessions, the CLI command tree; keys through the OS keychain module | every client over `<data dir>/run/host.sock` (0600, never TCP): length-prefixed JSON frames, mutual HMAC handshake, role-bound sessions (`ui`, `mcp`, `cli`, `admin`) |
| Electron main (`apps/desktop`) | windows, tray, menus, deep links, auto-update; one host session per renderer frame (`HostRelay`), relayed without parsing; starts the host when none answers (detached, Electron in Node mode) | renderer over the typed preload bridge and its store MessagePort; the host as a `ui` client |
| Electron renderer (sandboxed, `contextIsolation`) | React UI only; never opens SQLite | the host's store channel v5 (`@cashu/host-protocol/store`) through main's relay |
| `cashu` shim (`apps/cli`; CLI, `cashu mcp`) | native data dir resolution, connect-or-start, argv / stdio relay | the host as a `cli` or `mcp` client (`cli.exec`, `mcp.open` + lines) |
| Expo app (Hermes) | UI, the store and the sync engine in-process (sync SQLite driver, SQLCipher) | the sync relay (Firestore over REST) |

Only the host (and the Expo app, in-process) opens stores. depcruise `only-host-opens-stores`: an app
other than `apps/host` and `apps/mobile` imports no SQLite binding (`node:sqlite`, `better-sqlite3`,
`expo-sqlite`, op-sqlite) and not node-host's driver entry (`@cashu/node-host/sqlite`); test code is
exempt. The host's sync relay lives in `apps/host/src/relay` (pairing in `apps/host/src/pairing`);
the SQLite driver is available only through node-host's dedicated `sqlite` entry.
Inside the host, a store file opens only under the
`WriterLease` (apps/host `lease.ts`), which wraps the held machine lock that the exclusive open
(`openNodeSqlite(path, { exclusive })`) requires.

The host itself (`apps/host`): `startLocalHost` takes the lock and socket, records its start
(`run/starts.json`: after 3 unclean starts within 10 minutes it runs in safe mode, no jobs and no
network), opens the stores, serves `ui` sessions the store channel v5 and `admin` sessions status /
stop / handover. Every store has one write queue (commands of all sessions, sync applies, job writes
run one at a time; long applies in 1,000-event slices with other work between slices). A native vault
records each command's original key in durable private attempt metadata before any encrypted append,
then records its terminal outcome. A lost reply requires a read-only same-key lookup; the renderer
never resends a mutation automatically. It exits 0 after a 10-minute idle linger,
75 when its bundle was replaced (handover), and logs codes and counts only (`logs/host.log`).

This placement is why `useQuery` suspends on the desktop's first read (an async hop) and never on
mobile (a sync read); see [data-flow.md](data-flow.md).

How a renderer gets its store channel: the page posts `{ cashu: "store-port-request" }` to its own
window; the preload (which alone can talk to main) forwards it; main checks that the sending frame is
the app's own origin, creates a `MessageChannelMain`, keeps one end for that frame's `HostRelay` and
sends the other back to the frame, which receives it as a window message (`{ cashu: "store-port" }`).
MessagePorts cannot cross `contextBridge`, hence the window message. The relay connects to the data
dir's host as a `ui` client (connect-or-start), puts what the renderer posts into `store` frames as it
is and posts the host's `store` frames back as they came; it adds only `link` messages (`connecting`,
`starting`, `connected`, `unavailable`). Main never reads store data. When the host goes away (killed,
crashed, replaced) the relay reconnects, starting a new host; the renderer's client keeps its snapshots
(stale, `useConnection()` says so), and after the new session's `ready` re-sends its live queries.
Unanswered commands stay unknown until an explicit read-only same-key lookup can reconcile them
(e2e `93-host-restart`). The host is started on demand by the first page that asks and outlives the
window (it exits when idle); a dev or lab shell never registers a launch agent or login item.
