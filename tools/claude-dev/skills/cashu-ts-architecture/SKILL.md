---
name: cashu-ts-architecture
description: |
  Architecture of the cashU TypeScript stack: package layers and dependency direction, module boundaries, the headless screen hook + pure View pattern for the Electron desktop and the Expo app, data flow over the local event store (live useQuery, commands, forms), errors, money and TypeScript conventions, performance budgets, how each layer is tested and which machine check enforces which rule.

  Applicability - POSITIVE: any TypeScript in packages/ or apps/ of the cashU monorepo: domain ports, store events / materializers / queries / commands, sync, ui-logic feature hooks, screen hooks and route files on desktop and mobile, Electron main / utility process / preload, MCP / CLI / API code; reviewing such code; reading a `pnpm arch:check` or check-file.sh failure.

  Applicability - NEGATIVE: NOT what a View looks like (tokens, components, Storybook, copy: cashu-ui), NOT Expo / React Native platform mechanics (expo-* and Callstack skills), NOT the Python app under src/cashu, the legacy frontend/ SPA, or the shipped product skills in .claude/skills.
---

# cashu-ts-architecture

One way to place cashU TypeScript so logic never leaks into Views, modules never reach into each
other, and desktop and phone share logic (not necessarily components). Every rule below that a
machine can check is checked: `pnpm arch:check` for the repo, `tools/claude-dev/scripts/check-file.sh`
after each edit (the dev plugin runs it as a PostToolUse hook). Fix the cause a check names; never
silence a rule to get green.

## The layers (imports point down only)

| Layer | Package | May import (workspace) | Holds |
|---|---|---|---|
| Apps | `apps/desktop`, `apps/mobile`, `apps/cli`, `apps/sync-daemon`, `apps/relay` | any package, never another app | route files, screen hooks, Views, platform adapters, process lifecycle |
| Services | `packages/api`, `packages/mcp` | domain, store, sync, i18n | HTTP / MCP surfaces |
| UI logic | `packages/ui-logic` | domain, store, i18n | reusable feature hooks shared by desktop and mobile (no screens, no JSX) |
| UI system | `packages/ui` | domain, i18n | tokens, display components, platform controls (see `cashu-ui`) |
| Store | `packages/store` | domain, sync | events, materializers, queries, commands, the `useQuery` engine |
| i18n | `packages/i18n` | domain | catalogs runtime, plurals, `Intl` formatters, `useStrings` |
| Sync | `packages/sync` | domain | log, crypto, transports, lease |
| Domain | `packages/domain` | nothing (no npm, no node built-ins) | pure functions and types |

Details, module folders, exports maps, where processes run: [layers.md](references/layers.md).

## Non-negotiable

- **Domain is pure**: no I/O, clock (`asOf` is a parameter), randomness, SQLite, React or zod.
- **Writes are events.** UI and services never write SQL; a command validates and appends events,
  the materializer is the only writer of view tables.
- **Modules** (budget, assets, loans, investments) **never import another module's internals**;
  they meet in `core` or through a module's `index.ts`. Packages are imported by name through their
  `exports` map, never by a relative path.
- **Profile (vault) is explicit**: one store (view database) per vault, so the vault is the store a
  query or command runs against; view tables have no `profile_id`, and no query spans two vaults.
- **Money is `Decimal` in `Money { amount, currency }`**: never `number`, never summed across currencies.
- **Screens = headless screen hook + pure View.** Views may use presentational hooks only; never the
  store, commands, navigation or the network.
- **React Compiler is on everywhere React renders.** No manual `useMemo` / `useCallback` / `memo`
  (a measured exception carries a `biome-ignore` with the profiler evidence).
- **Reads are live and local**: `useQuery(query, args)` returns rows; no loading flags, no fetch caches.
- **Data never leaves the device**: no cloud crash reporting or analytics SDKs.
- **Transitional code is marked** `TRANSITIONAL(<scope that removes it>)`; `arch:check` lists every marker.
- Matching data stays Polish; UI text goes through catalogs (PL + EN). No em dash anywhere.

## Problem -> reference

| Task / question | Start with |
|---|---|
| Where does this new file / function go? Which package may import which? | [layers.md](references/layers.md) |
| A new screen, or the same screen on both platforms | [screen-hook-view.md](references/screen-hook-view.md) |
| Show data, react to changes, a user action that writes, a form | [data-flow.md](references/data-flow.md) |
| New event type, materializer or query | [data-flow.md](references/data-flow.md), `packages/store/spec/events.md` |
| Types, ids, errors, money, zod | [typescript.md](references/typescript.md) |
| Long lists, slow screens, startup time | [performance.md](references/performance.md) |
| How to test it | [testing.md](references/testing.md) |
| A check failed / adding a check / TRANSITIONAL markers | [enforcement.md](references/enforcement.md) |

## See also

- `cashu-ui` - tokens, components, Storybook, copy and plurals; what a View is made of.
- `packages/store/spec/events.md`, `packages/store/spec/gid.md` - event catalog and global ids.
- `docs/agents/sync-and-mobile.md` - why the stack looks like this.
- `expo:expo-router`, `expo:expo-project-structure`, `building-react-native-apps:react-native-best-practices` - platform mechanics.

## References

| File | Style | Impact | Description |
|---|---|---|---|
| [layers.md](references/layers.md) | pattern | CRITICAL | Packages, module folders, exports maps, allowed imports, platform code, which process runs what |
| [screen-hook-view.md](references/screen-hook-view.md) | pattern | CRITICAL | Route file + screen hook + pure View, feature hooks in ui-logic, Suspense and error boundaries, typed routes |
| [data-flow.md](references/data-flow.md) | pattern | CRITICAL | `useQuery` on `useSyncExternalStore`, table-based invalidation, `useCommand`, forms, global state, Electron store process |
| [typescript.md](references/typescript.md) | pattern | HIGH | Strictness, branded ids, unions, zod boundaries, errors, money, compiler idioms, naming |
| [performance.md](references/performance.md) | cheatsheet | HIGH | Written budgets, virtualization, compiler, measuring |
| [testing.md](references/testing.md) | pattern | HIGH | What to test per layer and how |
| [enforcement.md](references/enforcement.md) | cheatsheet | HIGH | Every check, what it catches, how to read and extend it, rule 7 |

## Self-audit checklist

After editing TypeScript in this skill's applicability, verify:

1. `pnpm arch:check` and `pnpm turbo run typecheck lint test` are green (or each remaining failure is
   in another scope and reported); no rule disabled, no ignore comment without a reason.
2. No import goes up the layer table, into another module's internals, or across packages by a
   relative path; new public API is exported from the module `index.ts` and the package `exports`.
3. A new screen is route file + `useXScreen` + `XView` (+ `XView.stories.tsx`); the View imports no
   store, sync, ui-logic hook, commands, navigation or network.
4. Every write goes through a store command that appends events; no SQL outside materializers and
   queries; no hand-listed invalidation.
5. Money stays `Money` / `Decimal`; no cross-currency sum; the vault's store is passed explicitly
   (never a profile filter).
6. No `useMemo` / `useCallback` / `memo`, no `loading` kind in screen state, lists over 50 rows virtualized.
7. Tests sit at the lowest layer that shows the behaviour; parity checks added for ported Python.
8. Temporary code carries `TRANSITIONAL(<scope>)`.
