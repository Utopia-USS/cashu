# Code map

What this is: the inventory of the repository (what lives where), so an agent reuses existing code instead of reinventing it.

## How to use this

Find the file that owns a concern before adding one. The app is a **core** plus **modules** (budget,
assets, loans, investments): core is always on (profiles, accounts, balances, net worth, registries,
proposals, workspaces); each module owns its domain rules, events, views, commands, CLI commands,
MCP tools and setup steps. A module never imports another module's internals: cross-module needs go
through core (net-worth contributors, account types, institutions, categorization hooks).

Dependencies point down the [layer table](../../tools/claude-dev/skills/cashu-ts-architecture/references/layers.md),
enforced by `LAYERS` in [depcruise.config.cjs](../../tools/arch/depcruise.config.cjs) (`pnpm arch:check`).
Apps compose packages and never import another app.

## Workspace members

| Path | Layer | Purpose |
|---|---|---|
| `packages/domain/` | Domain | Pure core/module types, validation, calculations, bank parsers, categorization and investments rules; no IO or external runtime imports. |
| `packages/sync/` | Sync | Event log, HLC, crypto, carrier/transport interfaces and device membership; depends on domain. |
| `packages/market/` | Market | Leader-only HTTP market/calendar sources (Yahoo, stooq, NBP) behind an injected fetch; parsing contracts live in domain. |
| `packages/llm/` | LLM | Ollama and Anthropic clients for categorization behind ports. |
| `packages/store/` | Store | Event schemas, materializers, queries, commands and services per module; vault and device stores. |
| `packages/store-react/` | Store bindings | React `useQuery` / command hooks and providers, plus React-free client/local/host/protocol store ports. |
| `packages/i18n/` | i18n | PL/EN catalogs, plurals, formatting and explicit backend translators; depends on domain. |
| `packages/ui/` | UI system | Shared tokens, display components, charts and platform controls; no store access. |
| `packages/ui-logic/` | UI logic | Platform-free UI logic and feature hooks (formatters, backend code labels, module logic); no app screens. |
| `packages/mcp/` | Services | MCP tool registry, tool handlers per module, privacy labels / redaction / audit and the native server runtime. |
| `packages/api/` | Services | HTTP surface scaffold. |
| `packages/host-protocol/` | Protocol | The host wire protocol: frames, handshake, roles, CLI / MCP / store / admin / banking messages, packaged-build rules (`packaged-build.md`, `native-creation.md`). |
| `packages/node-host/` | Node platform | Node adapters: SQLite, keyring (and the `cashu-next-test.*` test key store), folder IO, guards, language source, host service helpers. |
| `apps/host/` | Apps | One local host per data dir: exclusive stores, CLI and MCP sessions, worker, connectors, workspaces, banking, sync, Python-data migration. |
| `apps/desktop/` | Apps | Electron main/preload, React renderer, e2e suite, macOS packaging and native helpers. |
| `apps/cli/` | Apps | The `cashu` shim: a thin client of the host; bundled into the app as `shim.mjs`. |
| `apps/mobile/` | Apps | Expo/Hermes development client, routes/screens and native store/crypto/platform adapters. |
| `apps/relay/` | Apps | Sync relay scaffold. |
| `tools/arch/` | Development tooling | `pnpm arch:check`: runner, dependency graph, ESLint (react-hooks), Knip, sherif and the guard tests (`src/guards/`). |
| `tools/claude-dev/` | Development tooling | Repo-local TS architecture/UI skills and the file-check hook; not shipped to profile workspaces. |
| `tools/node-ts/` | Development tooling | Resolver for running workspace TS sources with Node type stripping (`resolveTs.ts`). |

## `packages/domain/src/`

| Path | Purpose |
|---|---|
| `core/profiles.ts` | slugs, the default slug, module choice, privacy levels (`strict` / `amounts`) |
| `core/modules.ts`, `core/builtinModules.ts` | `ModuleSpec`, `MODULE_IDS`, the four built-in module specs and the core registry |
| `core/accountTypes.ts` | account type registry: sign, liquid, net-worth bucket, labels |
| `core/institutions.ts` | bank/broker registry (`BUILTIN_INSTITUTIONS`): CSV importer, Open Banking ASPSP patterns |
| `core/networth.ts`, `core/valuation.ts` | net worth per currency over a `NetWorthBook`; `NetWorthContributor` and valuations |
| `core/setup.ts` | blank-page setup steps and copyable command prefixes |
| `core/workspace/` | the agent workspace plan: `MODULE_SKILLS`, managed CLAUDE.md sections, `.mcp.json` and settings rules |
| `budget/ingestion/statements/` | the built-in bank CSV parsers (`mbank.ts`, `erste.ts`, `pekao.ts`, `registry.ts`); `ingestion/` also holds dedup, content keys and the canonical budget import format |
| `budget/categorize/` | taxonomy, ~420 PL seed rules (`seedRules.ts`), engine, reclassify planning, LLM prompts (`llm/prompts.ts`) |
| `budget/analytics/`, `budget/cash.ts`, `budget/transfers.ts` | cashflow, spending, recurring payments; the cash pool; internal transfers by IBAN |
| `assets/` | manual positions, vehicle depreciation, net-worth contributor |
| `loans/` | amortization, valuation, installment phrases (`patterns.ts`), net-worth contributor |
| `investments/` | pure investments core: `domain/`, `portfolio/`, `market/`, `strategy/`, `rules/` (expression language: `rules/expr/EXPRESSIONS.md`), `importing/` (cashU import format, generic CSV mapping), `alerts/`, `plan/`, `performance/`, `research/`, `macro/`, `views/` |
| `testing/` | synthetic seeds (`seedHousehold.ts`, `netWorthProfile.ts`) and vector loaders |
| `pyJson.ts`, `pyRepr.ts`, `pyRegex.ts`, `pycsv.ts`, `pyYaml/` | Python-compatible primitives the port keeps byte-identical behaviour with (parsing old data and user files) |

## `packages/store/src/`

| Path | Purpose |
|---|---|
| `events/v1/` | the normative v1 event catalog per module (spec: `packages/store/spec/events.md`) |
| `registry.ts`, `modules.ts` | `StoreModule` (materializers, events, derivers, net worth, setup) and the built-in modules in fold order |
| `materialize.ts`, `rebuild.ts`, `upcast.ts` | applying events to views, view rebuilds on a changed fingerprint, event upcasters |
| `query.ts`, `subscribe.ts`, `command.ts` | `defineQuery`, the change hub (live queries), commands and durable command attempts |
| `core/`, `budget/`, `assets/`, `loans/`, `investments/` | each module's views, queries, commands and services (profiles, profile modules, proposals, net worth book, prices, strategy documents, ...) |
| `device/` | the device-local store (no event log) |
| `sql/` | system tables (`SYSTEM_SCHEMA_VERSION`) |

## `packages/mcp/src/`

| Path | Purpose |
|---|---|
| `registry.ts` | `ToolSpec`, `toolSpec()`, `ToolError`, module gating (`enabledIn`), provider order |
| `tools/` | tool handlers per module (`core`, `budget`, `loans`, `investments`, `investmentWrites`, `research`, `connectors`) |
| `runtime/` | `NativeMcpServer` (`server.ts`), the canonical tool order and schemas (`toolSchemas.ts`, `metadata.ts`) |
| `privacy/` | sensitivity labels, the redactor (strict drops amounts, identifiers never pass), name guard, scrub, audit |
| `providers/` | per-call store providers and the name guard |

## `apps/host/src/`

| Path | Purpose |
|---|---|
| `main.ts`, `host.ts`, `cli.ts` | host entry (`run` / `status` / `stop` / `migrate`), lifecycle, idle linger (10 min) |
| `localHost/` | startup (stores, launcher, worker), UI / CLI / MCP session wiring, RPCs (banking, devices, notifications, market) |
| `stores.ts`, `nativeVault/`, `nativeCreation*.ts` | opening the device store and the per-profile vaults; native profile creation with the 24-word recovery phrase |
| `launcher.ts`, `runtime.ts` | the stable launcher `<data dir>/bin/cashu`; source vs packaged runtime, shipped skills and connector catalog |
| `cli/` | the hosted `cashu` command tree: `tree.ts` (routing, retired commands), `ported.ts` (registration), `help.strings.ts`, per-module dirs (`budget/`, `assets/`, `loans/`, `investments/`, `connectors/`, `core/`), `banking.ts`, `workerWorkspace.ts` |
| `mcp/` | MCP sessions and the native backend; `tools.test.ts` pins the tool inventory |
| `worker/` | daily jobs (connectors fetch, investments daily check, budget sync, notifications, weekly digest), schedule (default 07:30) |
| `connectors/`, `connectorRuntime.ts`, `connector*.ts` | connector manifest, catalog, interpreter lookup, sandbox runner, egress proxy, secrets, offline test, install / approval / removal |
| `banking/` | Enable Banking client, consent callback, sync into the budget |
| `classification/` | categorization providers (Ollama, Anthropic with owner consent) |
| `workspace/` | per-profile agent workspace (managed CLAUDE.md, `.mcp.json`, `.claude/settings.json`, skills); `skillReferences.ts` = the reference copies inside skills |
| `market/`, `notifications/`, `proposals/`, `sync/`, `pairing/`, `devices/` | market data wiring and price cache; OS notifications; proposal approval; sync carrier; device pairing |
| `*Screen.ts` | screen data the renderer asks for (overview, investments, signals, review, research, strategies, proposals, settings) |
| `testing/` | synthetic hosts and demos (`devDemo.ts`, `seedOverviewDemo.ts`, ...) |
| `scripts/genConnectorSchemas.ts`, `scripts/syncSkillReferences.ts` | `gen:connector-schemas` and `skills:sync` (`--check` verifies) |

## `apps/desktop/`

| Path | Purpose |
|---|---|
| `src/main.ts`, `src/entry.ts`, `src/entryDispatch.ts` | Electron main: window, tray, deep links, host launch and relay, recovery; refuses CLI commands on the app binary |
| `src/update/` | auto-update (electron-updater) authority, controller and release policy |
| `renderer/` | React renderer: `routes.tsx`, `shell/`, `screens/<feature>/` (screen hook `use*Screen.ts` + pure `*View.tsx` + `*.strings.ts` + stories) |
| `e2e/` | Playwright suite (`desktop-specs/`, `global-setup.ts`) |
| `scripts/` | `dev.mjs` (dev run on a demo), `build-main.mjs`, `build-host.mjs` (bundles `host.mjs` and `shim.mjs`), `build-native.mjs`, `package-macos.mjs` (one arch, ad hoc or signed), `verify-package.mjs`, `release-macos.mjs` + `release/` (the release: 7 assets, `latest-mac.yml`, appcasts; [releasing.md](../releasing.md)), `release-policy.mjs`, `bump-version.mjs` |
| `build/electron-builder.config.cjs`, `build/entitlements.mac.plist`, `build/entitlements.release.mac.plist` | packaging config (ad hoc and release entitlements) |
| `native/`, `service/` | the macOS notification and host-service helpers, the host LaunchAgent |

## Other top-level paths

| Path | Purpose |
|---|---|
| `docs/connectors.md` | connector contract for outside authors (manifest, protocol, sandbox); schemas in `docs/schemas/` (generated) |
| `docs/import-format.md`, `docs/budget-import-format.md` | cashU investments / budget import formats |
| `docs/releasing.md`, `docs/releases/` | the release procedure (owner) and the hand-written release notes `v<X.Y.Z>.md` |
| `connectors/` | community connector catalog (contrib status, one dir per connector with `fixtures/`; shipped with the app, see its `README.md`); `<bank>-csv/` are the Deno twins of the built-in parsers |
| `examples/connectors/` | tested example connectors (budget CSV, investments JSON and fetch in Python; a Deno budget example) |
| `packaging/icon/` | the app icon used by electron-builder |
| `.claude/skills/` | the shipped product skills (see [skills.md](skills.md)) |
| `.claude/settings.json`, `.claude-plugin/`, `tools/claude-dev/` | repo-local dev plugin `cashu-dev`: the TS development skills (`cashu-ts-architecture`, `cashu-ui`), `scripts/check-file.sh` and its PostToolUse hook; never shipped to workspaces |
| `.github/workflows/ts.yml` | CI: install, `turbo run typecheck lint`, `pnpm test`, exhaustive tests, `arch:check`, mobile bundle check |
| `.github/workflows/bump-version.yml`, `release-macos.yml`, `staging-to-main-pr.yml` | version bump on `main`, the macOS release after it (behind the `release` environment), the `staging -> main` pull request |
| `data/` | (git-ignored) local drop folder (`data/incoming/` is the default of `cashu import-dir`) |
| `statements/` | (git-ignored) drop CSV statements here - empty in the repo |

## When to add a new entry

Add a row in the same change that adds a top-level file, package or script an agent would otherwise
not find. Remove rows for deleted paths: a stale row is worse than a missing one.
