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
- Live reads in React, the store client, the port between renderer and store process -> `store-react`
  (React-free subpaths: `./client` for the renderer, `./local` for an in-process engine, `./host` for
  the store process, `./protocol` for both ends).
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
| Electron main | windows, tray, menus, deep links, auto-update; one host connection per renderer frame, relayed without parsing (S56b) | renderer over the typed preload bridge; the host as a `ui` client |
| Electron renderer (sandboxed, `contextIsolation`) | React UI only; never opens SQLite | the host's store channel v2 (`@cashu/host-protocol/store`) through main's relay |
| `cashu` shim (CLI, `cashu mcp`; S56d) | data dir resolution, connect-or-start, stdio / argv relay | the host as a `cli` or `mcp` client |
| Expo app (Hermes) | UI and the store engine in-process (sync SQLite driver) | the relay / folder transport |
| Electron utility process (`apps/desktop/src/storeProcess`, behind `CASHU_DESKTOP_STORE=1`; replaced by the host in S56b) | today's store engine for the store-backed renderer | renderer over a `MessagePort` (`serveStore`, store protocol v1) |

Only the host (and the Expo app, in-process) opens stores. depcruise `only-host-opens-stores`: an app
other than `apps/host` and `apps/mobile` imports no SQLite binding (`node:sqlite`, `better-sqlite3`,
`expo-sqlite`, op-sqlite) and not node-host's driver entry (`@cashu/node-host/sqlite`); test code is
exempt. Marked exceptions until their scopes land: the S53 utility process (TRANSITIONAL(S56b)), the
sync daemon's harness and its use of node-host's root re-export of the driver (TRANSITIONAL(S56c)),
`cashu-next genesis` (TRANSITIONAL(S56d)). Inside the host, a store file opens only under the
`WriterLease` (apps/host `lease.ts`), which wraps the held machine lock that the exclusive open
(`openNodeSqlite(path, { exclusive })`) requires.

The host itself (`apps/host`): `startLocalHost` takes the lock and socket, records its start
(`run/starts.json`: after 3 unclean starts within 10 minutes it runs in safe mode, no jobs and no
network), opens the stores, serves `ui` sessions the store channel v2 and `admin` sessions status /
stop / handover. Every store has one write queue (commands of all sessions, sync applies, job writes
run one at a time; long applies in 1,000-event slices with other work between slices). A command's
idempotency key is recorded in the store's `host_requests` table in the same transaction as its
events, so a resent command is answered from the table. It exits 0 after a 10-minute idle linger,
75 when its bundle was replaced (handover), and logs codes and counts only (`logs/host.log`).

This placement is why `useQuery` suspends on the desktop's first read (an async hop) and never on
mobile (a sync read); see [data-flow.md](data-flow.md).

How a renderer gets its port: the page posts `{ cashu: "store-port-request" }` to its own window; the
preload (which alone can talk to main) forwards it; main checks that the sending frame is the app's
own origin, creates a `MessageChannelMain`, sends one end to the store process (`connect`) and the
other back to that frame, which receives it as a window message (`{ cashu: "store-port" }`).
MessagePorts cannot cross `contextBridge`, hence the window message. Main routes ports and never
reads store data. Until the first TS screen reads the store, this runs only behind
`CASHU_DESKTOP_STORE=1` next to the Python sidecar (TRANSITIONAL(S55a)).
