---
title: Machine checks (arch:check and the per-file hook)
impact: HIGH
tags: enforcement, biome, eslint, dependency-cruiser, knip, sherif, hooks, ci
---

# Machine checks

| Command | When | Scope |
|---|---|---|
| `tools/claude-dev/scripts/check-file.sh <file>` | after every edit (the `cashu-dev` plugin runs it as a PostToolUse hook on `.ts` / `.tsx` under packages/, apps/, tools/arch/) | one file, well under 3 s: Biome (safe fixes applied), dependency-cruiser for this file's imports, ESLint react-hooks for React files |
| `pnpm arch:check` | before a commit, in CI (`.github/workflows/ts.yml`) | the whole repo, all checks below, plus the TRANSITIONAL report |
| `pnpm turbo run typecheck lint test` | before a commit, in CI | types (TS 7), Biome per package, unit tests |
| `pnpm test:exhaustive` | in CI, in the pre-handoff gate (`pnpm check:handoff` = check + exhaustive + arch:check) | the exhaustive tier: `*.exhaustive.test.ts` sweeps, property searches, simulations, one package at a time (see [testing.md](testing.md), "Test tiers") |

## What each check catches

| Check | Config | Catches |
|---|---|---|
| Biome `noRestrictedImports` (per-folder overrides) | `biome.json` | upward / platform imports per package by specifier; manual memo; telemetry SDKs; fetch caches; navigation, store, commands in Views and packages/ui |
| Biome `noRestrictedGlobals` | `biome.json` | `fetch`, `XMLHttpRequest`, `WebSocket` in Views and packages/ui |
| Biome `noPrivateImports` | `biome.json` | imports of symbols tagged `@package` / `@private` from outside |
| Biome `noJsRestrictedProperties` | `biome.json` | `React.useMemo` / `React.useCallback` / `React.memo` |
| ESLint `eslint-plugin-react-hooks` (recommended + compiler rules) | `tools/arch/eslint.config.js` | rules of hooks, missing deps, compiler bail-outs (purity, refs, set-state-in-render / effect, immutability, static components) |
| dependency-cruiser | `tools/arch/depcruise.config.cjs` | layer direction on the resolved graph, module internals, cross-package relative imports, apps importing apps, pure Views and packages/ui (type-only imports allowed), test code in production, cycles |
| Knip | `tools/arch/knip.jsonc` | unused files, exports, types, dependencies, unlisted dependencies and binaries |
| sherif | flags in `tools/arch/src/run.ts` | package.json hygiene, one version per dependency |
| guard tests | `tools/arch/src/guards/` | raw color / spacing / type literals in `apps/**/*.tsx`; PL / EN catalog parity incl. plural categories (runtime `catalog()` objects too); Polish UI text outside catalogs in the UI packages and apps; story coverage of packages/ui exports and app Views; exports maps on every package; React Compiler on in every React app; both test tiers wired in every vitest package |
| backend translation guard | `tools/arch/src/guards/backendTranslation.test.ts` | backend (including relay) i18n imports/re-exports outside the reviewed pure root allowlist, UI catalog subpaths, or whole-module access; pass an immutable request/run `Translator`; renderer/UI and test-only code are outside this rule |
| TRANSITIONAL markers | `tools/arch/src/guards/transitional.ts`, registry `tools/arch/scopes.json` | lists every `TRANSITIONAL(<scope>)` marker by scope (TS, Python, patches, docs); fails when a marker names a scope that is not live (done, dropped or unknown): re-point it to the live scope that removes it or remove the code; a closed scope leaves the registry in the same change as its markers |

Packages are wired so the cheapest layer does the most: `package.json` dependencies + pnpm's isolated
`node_modules` make undeclared imports unresolvable, `exports` maps make private paths unreachable,
and dependency-cruiser covers what package.json cannot see (module to module inside one package, and
hoisted installs if Expo ever forces `node-linker=hoisted`).

## Reading a failure

Every message names the rule and the way out (move the code down a layer, use the module's
`index.ts`, pass the value in as a prop, add the story). Fix the cause. Lab rule 7: never disable or
loosen a rule, add an ignore entry, or write a shim to get green. If the proper fix is bigger than the
task, do the minimal correct part, mark temporary code `TRANSITIONAL(<scope that removes it>)` (a live id from
`tools/arch/scopes.json`) and report the rest. A violation in another running scope's files is reported, not edited.

## Changing a rule

A new architecture rule lands with its check in the same change: the rule in the skill reference,
the config (Biome override / depcruise rule / guard test), and a planted violation proven to fail
with a clear message. Rules a machine cannot check (wrong abstraction, intent naming, query plans)
stay with the fresh-context reviewer.
