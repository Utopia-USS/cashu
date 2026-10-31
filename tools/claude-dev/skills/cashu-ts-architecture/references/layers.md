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
| store, sync, i18n, ui-logic stay platform free (no `node:*`, Electron, React Native, Expo, DOM) | Biome overrides |

Need data from another module? Use its public `index.ts`, or move the shared concept to `core`.

## Where does it go?

- A rule that stays the same with a different UI (net worth, transfer matching, a signal) -> `domain`.
- Turning events into rows, or reading rows -> `store` (materializer / query).
- "When the user taps X, record Y" -> a `store` command, called from a screen hook.
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

| Process | Runs | Talks to |
|---|---|---|
| Electron main | windows, tray, menus, deep links, auto-update, spawns the utility process | renderer over the typed preload bridge |
| Electron utility process (`utilityProcess.fork`) | the store engine: SQLite, materializer, sync, the daily worker, MCP server | renderer over a `MessagePort` (query snapshots pushed, commands in) |
| Electron renderer (sandboxed, `contextIsolation`) | React UI only; never opens SQLite | utility process through the port |
| Expo app (Hermes) | UI and the store engine in-process (sync SQLite driver) | the relay / folder transport |

This placement is why `useQuery` suspends on the desktop's first read (an async hop) and never on
mobile (a sync read); see [data-flow.md](data-flow.md).
