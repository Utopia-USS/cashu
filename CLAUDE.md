# cashU

A local personal-finance tracker for Polish banks and brokers: a native desktop app (Electron shell +
a TypeScript local host that owns the encrypted per-profile stores, the `cashu` CLI and the MCP
server), data per profile, everything runs locally. pnpm + turbo monorepo.

> This file is also accessible as `AGENTS.md` (symlink) for tools that follow the OpenAI / Codex
> convention, and `.agents/skills` links to `.claude/skills`. Edit `CLAUDE.md` and `.claude/skills/`;
> the symlinks keep both views in sync.

This file is for the **agent** (Claude Code / any assistant) helping the user run and extend the
project. It is the inventory and routing map; the deep content lives in [`docs/agents/`](docs/agents/).

## Topology

```
cashu/
├── apps/
│   ├── desktop/        # Electron shell: main, preload, React renderer (screens), e2e/, macOS packaging scripts
│   ├── host/           # the local host (one per data dir): stores, `cashu` command tree, MCP sessions, worker,
│   │                   #   connectors, agent workspaces, Open Banking, Python-data migration
│   ├── cli/            # the `cashu` shim: thin client of the host (bundled into the app as shim.mjs)
│   └── mobile/, relay/ # Expo dev client and the sync relay scaffold (in development)
├── packages/           # domain, store, sync, i18n, ui, ui-logic, store-react, mcp, market, llm,
│                       #   host-protocol, node-host, api
├── tools/              # arch/ (`pnpm arch:check`), claude-dev/ (dev plugin), node-ts/ (TS source resolver)
├── .claude/skills/     # product skills shipped to each profile's agent workspace
├── docs/               # import formats, connector contract + schemas, migration runbook, agents/ = dev guide
├── connectors/         # community connector catalog (contrib status), shipped read-only with the app
├── examples/connectors/
└── data/, statements/  # git-ignored: local drop folders (CSV statements), never committed
```

## Data-safety rules (most important - do not break them)

This project works with the user's real financial data. **Never** leak data into the repository or
off the machine:

1. **Never commit data.** These never go into git: `data/**`, `statements/**` (CSVs), `.env*`,
   `*.pem`. They are all in `.gitignore`. Before every commit, run
   `git status` - if you see a data file staged, **stop and report it to the user**. The real data
   lives in the per-user data dir outside the repo (macOS `~/Library/Application Support/cashU`,
   Linux `~/.local/share/cashu`, `CASHU_DATA_DIR` overrides; `apps/cli/src/dataDir.ts`): one encrypted
   vault per profile under `stores/vaults/`, keys in the OS keychain.
   Tests and fixtures always use temp data dirs and the test keychain namespace (`cashu-next-test.*`,
   `createTestKeyStore` from `@cashu/node-host/testing`); never a real keychain item.
   Outside tests, a git-ignored `.env.dev` at the checkout root (also read by every git worktree of
   it, `apps/cli/src/devenv.ts`) points the CLI and the dev host of a checkout at a demo data dir.
2. **Never write balances, IBANs, names, or transactions** into files that could land in the repo
   (code, tests, docs). Tests use synthetic data; never paste real statements.
3. **Never send data to a cloud LLM.** The `anthropic` categorization backend sends only the
   merchant-name string - never IBANs, balances, or names - and only after the owner's consent in
   the app. The default backend is local `ollama` (offline). Don't change this without the user's
   explicit OK.
4. **Bank credentials (login/password/SCA) are entered only by the user** in the bank's browser. The
   code never sees them and must never ask for them.
5. **Net worth is computed per-currency** (never sum currencies); **internal transfers are matched by
   counterparty IBAN only** (never by name/amount).
6. **Never run `eb resync` / `reclassify` in a loop** - banks throttle PSD2 (429), and the local LLM
   is slow. Sync ~once a day.
7. **Never mix profiles**: each profile is its own vault; a query, command or MCP session works on
   exactly one vault, and data of one profile must never show up in another.

Full "What NOT to do" list with reasons: [docs/agents/conventions.md](docs/agents/conventions.md).

## Language convention

The codebase is English (comments, docs, CLI help). The **UI is Polish and English**: every text the
app shows lives in both languages (`*.strings.ts` catalogs through `catalog()` from `@cashu/i18n`;
backend code renders through an explicit `Translator`); the language follows the OS, else English,
and Settings can pin it. Agent-written content (research notes, theses) is shown as written. Full
contract and glossary: [docs/agents/localization.md](docs/agents/localization.md).

**Matching data is intentionally Polish and must stay Polish**: parser CSV headers (`#Data operacji`,
`Rachunek źródłowy`, ...) in `packages/domain/src/budget/ingestion/statements/`, the ~420 PL seed
rules in `budget/categorize/seedRules.ts`, installment phrases in
`packages/domain/src/loans/patterns.ts`, the LLM prompts in `budget/categorize/llm/prompts.ts`, the
word lists in `packages/domain/src/investments/research/`. Translating them breaks matching on real
data.

Rule of thumb: **explanation for a developer -> English; text shown to the user -> both languages
through a catalog / `Translator`; data** (matched, or sent to the LLM as a prompt/enum) **-> Polish**.
Never the em dash; use a hyphen. Full form: [docs/agents/conventions.md](docs/agents/conventions.md).

## Required setup

```bash
corepack enable && pnpm install --frozen-lockfile    # Node >=22 (.nvmrc), pnpm pinned in package.json
pnpm --filter @cashu/desktop dev                     # builds the desktop app and opens it on a synthetic demo
```

**If the user is just getting started** -> walk them through setup following
[`ONBOARDING.md`](ONBOARDING.md), step by step, waiting for confirmation after each step.

## Repository overview

cashU pulls transactions from Polish banks (**mBank**, **Erste** / former Santander, **Pekao**) via
CSV export and optionally Open Banking (Enable Banking), normalizes them to a common model,
deduplicates, detects internal transfers between the user's own accounts, categorizes spending, and
computes net worth, monthly cashflow, and recurring payments. Data is kept per **profile** (a person
or a household; one encrypted vault each), and features come in **modules** (budget, assets, loans,
investments) chosen per profile. The product is the native desktop app: an Electron window over a
local host process that owns the stores and serves the UI, the `cashu` CLI and the MCP server.
Everything runs **locally**. Stack: TypeScript (strict ESM), Node 22, Electron, React, SQLite
event-sourced stores, Biome, vitest, Playwright.

| Workspace | Purpose |
|---|---|
| `packages/domain/` | pure rules: profiles, modules (`ModuleSpec`), accounts, net worth, institutions, bank parsers, categorization, loans, assets, investments math; no IO |
| `packages/store/` | event log, materialized views, queries, commands per module; vault and device stores |
| `packages/mcp/` | MCP tool registry, privacy labels and redaction, the native MCP server runtime |
| `packages/i18n/`, `ui/`, `ui-logic/`, `store-react/` | PL/EN catalogs and translators; UI system; platform-free UI logic; React query/command bindings |
| `packages/sync/`, `market/`, `llm/`, `host-protocol/`, `node-host/`, `api/` | sync engine; market data sources; Ollama / Anthropic clients; host wire protocol; Node platform adapters (SQLite, keychain, guards); API scaffold |
| `apps/host/` | the local host: stores, CLI tree (`src/cli/`), MCP sessions (`src/mcp/`), worker, connectors runtime, workspaces, banking, migration |
| `apps/desktop/` | Electron main/preload, renderer screens, e2e, packaging and release (`scripts/package-macos.mjs`, `scripts/release-macos.mjs`) |
| `apps/cli/` | the `cashu` shim: routes `app`, `host`, `migrate`, `mcp` and forwards every other command to the host |
| `.claude/skills/` | the 9 shipped product skills (inventory below) |
| `docs/` | `import-format.md`, `budget-import-format.md`, `connectors.md`, `schemas/`, `migration-runbook.md`, `releasing.md`, `releases/` (release notes), `agents/` |
| `tools/` | architecture checks and dev plugin |

Full file-level map: [docs/agents/code-map.md](docs/agents/code-map.md).

## Skills inventory

These are **product skills**, not dev tooling: they ship with cashU (inside the app's Resources) and
are copied into each profile's agent workspace (`apps/host/src/workspace/`). Every skill follows the
utopia-ai-arch:layer shape (POSITIVE / NEGATIVE applicability in the description, References table,
See also, Self-audit); `apps/host/src/workspace/workspace.test.ts` checks the inventory and
applicability. A new skill must be added to `MODULE_SKILLS` in
`packages/domain/src/core/workspace/plan.ts` (or to the always-on list in
`apps/host/src/workspace/production.ts`). Details and editing rules:
[docs/agents/skills.md](docs/agents/skills.md).

| Skill | Module | Applicability |
|---|---|---|
| `workspace-setup` | core | Agent layout of a profile workspace (CLAUDE.md inventory, `AGENTS.md` + `.agents/skills` links for Codex) and the user's own skills in the same shape - NOT module setup, importers, portfolio rules or research |
| `budget-setup` | budget | Budget module setup: app check, banks, CSV vs Open Banking, categorization backend (Ollama vs Anthropic), first categorization pass via MCP - NOT broker exports, manual assets, loans or investments |
| `assets-setup` | assets | Manually valued assets (property, car with a depreciation curve, other), CLI placeholders, revaluing, MCP check - NOT loans, bank accounts and cash, or brokerage accounts |
| `loans-setup` | loans | Each loan's terms, installments recognised by a title phrase, balance the bank reports, MCP check - NOT the property or car itself, bank imports or spending categories |
| `investments-setup` | investments | Strategy interview (goals, horizon, risk, history retrospective), strategy.md + strategy.yaml proposals, weekly / monthly / quarterly check-ins - NOT broker-export conversion, one custom rule or market research; never recommends instruments or trades |
| `import-builder` | budget, investments | Broker / exchange / crypto history or bank statements turned into a file or fetch connector (preferred), a one-off converter or a generic CSV mapping - NOT supported bank CSV / Open Banking imports, strategy or custom rules |
| `extension-builder` | investments | One monitoring idea as a built-in rule kind or safe custom expression (`propose_custom_rule`), backtested and tuned - NOT a whole strategy, imports or alert proposals after a research run |
| `review` | investments | The periodic review deck in chat (world, sectors, positions, events, ideas, calendar, decide) from `review_context`, decisions, `mark_review_done` with the agenda; the strategy.yaml `review:` section - NOT the strategy, research runs, rules or imports |
| `market-research` | investments | Held / watched instruments, topics, macro cards, candidates and theses researched over MCP into sourced Polish notes, topic market views and model recommendations - NOT strategy or thesis writing, custom rules, imports or placing trades |

(Inventory only - descriptions live in each `SKILL.md` frontmatter.)

## Development skills

The skills above are **product skills** (they ship to users' workspaces; `.claude/skills/` holds
nothing else). Skills for **developing** the TypeScript stack live in the repo-local plugin
`cashu-dev` (`tools/claude-dev/`, marketplace `.claude-plugin/marketplace.json`), which
`.claude/settings.json` enables for every session in this checkout:

| Skill | Applicability |
|---|---|
| `cashu-ts-architecture` | TypeScript in `packages/` and `apps/`: layers, module boundaries, screen hook + pure View, `useQuery` / commands / forms, performance budgets, testing, the machine checks - NOT visuals or copy |
| `cashu-ui` | the UI system: tokens, shared and platform components, value components, lists, charts, Storybook, copy and Polish plurals - NOT logic, data or navigation |

The plugin's PostToolUse hook runs `tools/claude-dev/scripts/check-file.sh` on every edited `.ts` /
`.tsx` under `packages/`, `apps/` or `tools/arch/` and reports violations back; `pnpm arch:check` is the
whole-repo version (also in CI). Fix the cause a check names; never loosen a rule to get green.

## When to Invoke

| Situation | Read first | Files / guards |
|---|---|---|
| Orient in the code, find where something lives | [code-map.md](docs/agents/code-map.md) | - |
| Touch money, net worth, transfers, loans, cash, categorization, investments math | [data-model.md](docs/agents/data-model.md) | `packages/domain/src/core/networth.ts`, `packages/domain/src/<module>/networth.ts` |
| Add a module | [extending.md](docs/agents/extending.md) "Adding a module" | `packages/domain/src/core/modules.ts` `MODULE_IDS`, `builtinModules.ts`, `packages/store/src/modules.ts` |
| Add a screen / UI feature | [extending.md](docs/agents/extending.md) "Adding a screen", `cashu-ts-architecture` skill | `apps/desktop/renderer/screens/`, `packages/ui-logic/`, `apps/desktop/e2e/desktop-specs/` |
| Add an MCP tool | [extending.md](docs/agents/extending.md) "Adding an MCP tool" | `packages/mcp/src/registry.ts`, `runtime/toolSchemas.ts`, `privacy/`, `apps/host/src/mcp/tools.test.ts` |
| Change an event or a view (store schema) | [data-model.md](docs/agents/data-model.md) rule 15 | `packages/store/spec/events.md`, `packages/store/src/upcast.ts`, `upgrade.test.ts`, `view-upgrade.test.ts` |
| Fix a built-in bank CSV parser | [extending.md](docs/agents/extending.md) "Bank CSV parsers" | `packages/domain/src/budget/ingestion/statements/`, `connectors/<bank>-csv/` |
| Add an importer / connector | [extending.md](docs/agents/extending.md), [docs/connectors.md](docs/connectors.md), [connectors/README.md](connectors/README.md) (catalog) | `docs/import-format.md`, `docs/budget-import-format.md`, `examples/connectors/`, `apps/host/src/connectors/`, `pnpm --filter @cashu/host gen:connector-schemas` |
| Add a CLI command | [extending.md](docs/agents/extending.md) "Adding a CLI command" | `apps/host/src/cli/ported.ts`, `tree.ts`, `help.strings.ts` |
| Edit or add a shipped skill | [skills.md](docs/agents/skills.md) | `packages/domain/src/core/workspace/plan.ts`, `apps/host/src/workspace/skillReferences.ts`, `pnpm --filter @cashu/host skills:sync` |
| Add or change any user-visible text (UI copy, backend label, notification) | [localization.md](docs/agents/localization.md) | `packages/i18n` (`@cashu/i18n`), `*.strings.ts`, `tools/arch/src/guards/` |
| UI copy, charts, components | [conventions.md](docs/agents/conventions.md) "UI copy", `cashu-ui` skill | `packages/ui/`, `packages/ui-logic/src/core/messages.ts` |
| Research / MCP privacy (what the agent may see) | [skills.md](docs/agents/skills.md) "Rules every skill follows" | `packages/mcp/src/privacy/`, `packages/mcp/src/runtime/server.ts` |
| Run, demo data, e2e, verify in the app | [running.md](docs/agents/running.md) | `apps/desktop/scripts/dev.mjs`, `apps/host/src/testing/devDemo.ts`, `apps/desktop/e2e/` |
| Write tests | [conventions.md](docs/agents/conventions.md) "Tests" | `vitest.tiers.ts`, `@cashu/node-host/testing`, `packages/domain/src/testing/` |
| Moving a user from the Python app | [docs/migration-runbook.md](docs/migration-runbook.md) | `apps/host/src/migration/` (`cashu migrate`, `cashu migrate verify`) |
| Packaging / desktop app build | [running.md](docs/agents/running.md) "Packaging" | `apps/desktop/scripts/package-macos.mjs`, `apps/desktop/build/electron-builder.config.cjs` |
| Updates and releases (owner only) | [docs/releasing.md](docs/releasing.md), [s47-update-operator.md](docs/agents/s47-update-operator.md) | `apps/desktop/scripts/release-macos.mjs`, `.github/workflows/release-macos.yml`, `bump-version.yml`, `apps/desktop/src/update/` |
| Help the end user set up | [ONBOARDING.md](ONBOARDING.md) | the module setup skills |

## Common commands

| Task | Command |
|---|---|
| Install | `pnpm install --frozen-lockfile` |
| Typecheck / lint / tests (synthetic data - safe) | `pnpm typecheck`, `pnpm lint`, `pnpm test` (all three: `pnpm check`) |
| Exhaustive test tier | `pnpm test:exhaustive` |
| Architecture checks | `pnpm arch:check` (whole repo); `tools/claude-dev/scripts/check-file.sh <file>` (one file) |
| Full handoff gate | `pnpm check:handoff` (check + exhaustive + arch) |
| Mobile bundle budget | `pnpm bundle:check` |
| Desktop app on a synthetic demo | `pnpm --filter @cashu/desktop dev` |
| Desktop e2e | `pnpm --filter @cashu/desktop build && pnpm --filter @cashu/desktop e2e` |
| `cashu` from a checkout | `pnpm cashu-next <command>` (e.g. `pnpm cashu-next --help`; `.env.dev` decides the data dir) |
| `cashu` of an installed app | `"<data dir>/bin/cashu" <command>` (the launcher the host writes), or `ELECTRON_RUN_AS_NODE=1 /Applications/cashU.app/Contents/MacOS/cashU /Applications/cashU.app/Contents/Resources/shim.mjs <command>` |
| Regenerate connector schemas | `pnpm --filter @cashu/host gen:connector-schemas` (`--check` to verify) |
| Refresh skill reference copies | `pnpm --filter @cashu/host skills:sync` (`--check` to verify) |
| Connect a profile's MCP server | the profile's agent workspace registers it in `.mcp.json`; by hand: `claude mcp add cashu-<slug> -- "<data dir>/bin/cashu" mcp --profile <slug>` |
| Profile agent workspace | Settings > AI agent (MCP) in the app, or `cashu --profile <slug> workspace init` / `workspace update` |
| Import data from the Python app | `cashu migrate --recovery-file <file>`, then `cashu migrate verify` ([runbook](docs/migration-runbook.md)) |
| Build cashU.app (macOS, ad hoc) | `node apps/desktop/scripts/package-macos.mjs arm64` (`x64`; `--dmg` for a disk image) |
| Build the owner's `cashU Staging` app | `node apps/desktop/scripts/package-macos.mjs arm64 --flavor staging` ([releasing.md](docs/releasing.md) "Staging build") |
| Release (owner only) | merge `staging` -> `main` and approve the `release` environment; fallback `node apps/desktop/scripts/release-macos.mjs --check` ([releasing.md](docs/releasing.md)) |

## Documentation

- [docs/agents/code-map.md](docs/agents/code-map.md) - file-level repository map
- [docs/agents/data-model.md](docs/agents/data-model.md) - how the numbers work, vaults, live data, store schema evolution
- [docs/agents/conventions.md](docs/agents/conventions.md) - language, versions, CLI, tests, UI copy, what NOT to do
- [docs/agents/localization.md](docs/agents/localization.md) - Polish / English UI: language choice, catalogs, backend translators, glossary
- [docs/agents/extending.md](docs/agents/extending.md) - recipes: module, screen, MCP tool, CLI command, store schema change, connector
- [docs/agents/running.md](docs/agents/running.md) - running, demo data, e2e, packaging
- [docs/agents/skills.md](docs/agents/skills.md) - shipped skills, their rules, editing them
- [docs/agents/strategies.md](docs/agents/strategies.md) - design note: strategies as documents
- [docs/agents/connector-runtime.md](docs/agents/connector-runtime.md) - design spike: connectors on macOS, Linux and Windows (Deno tier)
- [docs/agents/connector-sandbox-platforms.md](docs/agents/connector-sandbox-platforms.md) - design spike: connector sandboxes per OS
- [docs/agents/sync-and-mobile.md](docs/agents/sync-and-mobile.md) - design spike: multi-device sync, mobile app, TypeScript stack
- [docs/releasing.md](docs/releasing.md) - releasing cashU.app: CI and local paths, one-time setup, release notes, staging build (owner)
- [docs/agents/s47-update-operator.md](docs/agents/s47-update-operator.md) - update contract inside the desktop app (Team ID, feed, install sequence)
- [docs/migration-runbook.md](docs/migration-runbook.md) - moving an install from the Python app to the native app
- [ONBOARDING.md](ONBOARDING.md) - end-user setup the agent walks through
- [README.md](README.md) - product overview
- [docs/connectors.md](docs/connectors.md), [docs/import-format.md](docs/import-format.md), [docs/budget-import-format.md](docs/budget-import-format.md) - external formats and contracts
