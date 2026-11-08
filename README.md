<p align="center"><img src="docs/assets/logo-cashu.png" alt="cashU" width="560"></p>

# cashU - a local personal-finance and investing companion

An open-source, local-first app for your money: budget, assets, loans and investments in one desktop
app, plus Claude Code agents that help you set it up and research your positions. cashU started as a
fork of [finanse](https://github.com/SynSzakala/finanse) (MIT, the original copyright is kept in
[LICENSE](LICENSE)).

It pulls transactions from Polish banks (**mBank**, **Erste** / former Santander, **Pekao**) via CSV
export and optionally Open Banking, normalizes them to a common model, deduplicates, detects internal
transfers between your own accounts, categorizes spending, and shows **net worth over time, monthly
cashflow, recurring payments, loans, and asset depreciation**. Data is kept per **profile** (you, your
partner, the household), and each profile picks the **modules** it uses (budget, assets, loans,
investments). The investments module keeps you on your own written strategy: rule signals on market
data, alerts, theses and a watchlist, never orders, never price predictions.

> 🔒 **Privacy.** Everything runs **locally**. Each profile is an **encrypted vault** in your per-user
> data dir, outside the repository (`~/Library/Application Support/cashU` on macOS,
> `~/.local/share/cashu` on Linux; override with `CASHU_DATA_DIR`); its key lives in the OS keychain
> and a 24-word recovery phrase you write down when you create the profile. Statements and `.env*` are
> git-ignored, so nothing **lands in the repository**. The app's local host talks to the window, the
> `cashu` command and the MCP server over a private local socket only. Bank passwords never pass
> through this code - you log in (SCA) yourself in the bank's browser. Categorization uses a local
> offline model by default; the optional cloud mode sends **only merchant names**, after your consent.
> Network calls happen only for sources you switch on (Open Banking, market prices and rates for
> investments) and, in an official signed release, the update check of its fixed feed; builds from
> source never contact an update server.

> 🌐 **Language.** Code, comments, and docs are in English. The **app is in Polish and English**: it
> follows the system language (English when it is neither) and can be pinned in Settings. The
> categorization keywords and LLM prompts stay Polish - the tool targets customers of Polish banks, and
> those strings are matched against Polish transaction text.

Stack: TypeScript · Electron · React · Node 22 · event-sourced SQLite stores · pnpm + turbo monorepo.

---

## 🚀 Fastest start - with an AI agent

The project is set up so an **agent (e.g. Claude Code) walks you through the whole setup step by
step** - from getting the app, through loading your data, to your first categorization pass.

```bash
git clone https://github.com/Utopia-USS/cashu.git && cd cashu
```

Open the directory in Claude Code (or another file-aware assistant) and say:

> **"Walk me through the setup following ONBOARDING.md."**

The agent reads [`ONBOARDING.md`](ONBOARDING.md) and [`CLAUDE.md`](CLAUDE.md) (also available as
`AGENTS.md` for Codex-style tools), then runs the steps with you, asking questions where a decision is
needed (CSV import or Open Banking, which categorization model, etc.). The agent knows the safety rules
and **won't commit your data**.

---

## 🖥️ The macOS app

cashU is a normal Mac app, `cashU.app` (macOS 13 or later). **Download** the dmg for your Mac from the
[latest release](https://github.com/Utopia-USS/cashu/releases/latest): `cashU-<version>-mac-arm64.dmg`
on Apple silicon, `cashU-<version>-mac-x64.dmg` on Intel. Releases are signed and notarized, and the app
installs later versions itself (Settings > Updates).

**Or build it** from this repository (macOS, Node.js 22, Xcode command line tools):

```bash
corepack enable && pnpm install --frozen-lockfile
node apps/desktop/scripts/package-macos.mjs arm64     # x64 on an Intel Mac; --dmg adds a disk image
# -> build/t46/electron-builder/mac-arm64/cashU.app and build/t46/cashU-<version>-mac-arm64.zip
```

**Install it:** drag `cashU.app` to `/Applications` and open it. The first launch opens the profile
wizard: name, modules, base currency, then the recovery phrase of the new encrypted profile (write it
down; it is shown once). The wizard can also create the profile's agent workspace.

**Gatekeeper:** a build from source is signed ad hoc, runs on the Mac that built it and does not
update itself. Copied to
another Mac, macOS blocks it as "from an unidentified developer": open it once, then confirm in System
Settings > Privacy & Security > "Open Anyway" (only for a build you made yourself).

**Coming from the Python cashU app?** Install the native app over it. The app does not import the old
data itself: on its first start it finds the old data, leaves it untouched and gives you a prompt to
copy for your AI agent (for example Claude Code), which brings the data over through the app's import
paths (the `import-builder` skill), for you to approve in the app. You can also continue without it.
From finanse (the name before cashU, legacy
name): [`docs/upgrading-from-finanse.md`](docs/upgrading-from-finanse.md).

### The `cashu` command

The app ships its command line too. Every start writes a small launcher, `<data dir>/bin/cashu`, so
scripts and AI agents keep working when the app moves or updates:

```bash
alias cashu="$HOME/Library/Application Support/cashU/bin/cashu"
cashu --help
cashu --profile <slug> import-dir statements     # bank from the subdir name, idempotent
cashu --profile <slug> match-transfers           # pair internal transfers (by IBAN)
cashu --profile <slug> categorize                # categories (PL rules; --llm for the tail)
cashu --profile <slug> stats                     # net worth per currency + cashflow
```

Before the app has run once, the same command is
`ELECTRON_RUN_AS_NODE=1 /Applications/cashU.app/Contents/MacOS/cashU /Applications/cashU.app/Contents/Resources/shim.mjs <command>`.
Profiles are created in the app or with `cashu profiles add "<name>"` (each one is a vault with its
own recovery phrase); `cashu profiles list` lists them.

**Investments?** Add a brokerage account and import your history in the cashU import format
([`docs/import-format.md`](docs/import-format.md)) or with a CSV column mapping, then write a strategy
(the `/investments-setup` skill) and run the rules:

```bash
cashu invest accounts add "XTB IKE" --broker xtb --wrapper ike
cashu invest import history.csv --account <gid>  # --dry-run to preview
cashu invest run                                 # prices, valuation, rules, signals
cashu invest positions
```

**In the background:** Settings > Praca w tle (Background work) keeps a host service running after you
close the window; it runs the daily jobs (default 07:30): the rules check of every profile with
investments, the bank sync of profiles with Open Banking (at most once a day, backing off after a bank
rate limit), connector fetches, a notification for each new signal your strategy lists under
`notifications.immediate`, and a weekly digest. `cashu worker status` shows the last and next run.

---

## What it does

- **Net worth over time** - per-currency (never mixes currencies), broken down by asset/liability
  class (cash, property, vehicle, mortgage, loan).
- **Monthly cashflow** - income vs expenses, excluding transfers within your own net worth.
- **Where the money goes** - spending categorization (25 categories, ~420 PL rules + optional LLM),
  drill-down to transactions with corrections that teach the system.
- **Recurring payments** - subscription detection.
- **Loans** - any number per profile; annuity amortization (payment, schedule, outstanding debt, total
  interest); the net-worth balance decreases over time, and a balance from a bank statement takes over
  from its date. Installments are recognised as loan repayments, never as subscriptions.
- **Assets and cash** - car depreciation, manual positions, cash tracking.
- **Investments** - brokerage accounts, FIFO positions valued with stored prices and NBP rates,
  allocation vs your strategy, rule signals, alerts, a decision journal, research notes and a periodic
  review; the portfolio counts toward net worth in each account's currency.

The app shows an overview plus a page per enabled module, with Settings for profiles, modules, the AI
agent, connectors and Open Banking, background work and secrets. The UI is in Polish or English
(Settings > App > Language).

---

## AI agents (MCP and skills)

Every profile has its own local MCP server (`cashu mcp --profile <slug>`), so Claude Code or Claude
Desktop can read and propose changes without ever touching the vault. The privacy level is per
profile and **strict by default**: shares and percentages, no amounts, never account numbers or other
identifiers (it covers what the app gives the agent; a file you hand the agent yourself is your call).
Agent writes are proposals you approve in the app, and the app runs only connectors you approved
(below).

The easiest way in is the profile's **agent workspace** (created in the wizard or in Settings > AI agent
(MCP)): a folder with the MCP server already registered, the skills and the permissions. Open it in
Claude Code. By hand, once per profile:

```bash
claude mcp add cashu-<slug> -- "$HOME/Library/Application Support/cashU/bin/cashu" mcp --profile <slug>
```

The app ships Claude Code skills for each module (`/budget-setup`, `/assets-setup`, `/loans-setup`,
`/investments-setup`) and for investments work (`/import-builder` for unsupported broker exports,
`/extension-builder` for custom rules, `/market-research` for dated, sourced research notes, `/review`
for the periodic review). Details: [`docs/agents/skills.md`](docs/agents/skills.md).

---

## Connectors (any bank or broker, no fork)

A bank or broker cashU does not read can be added with a **connector**: a small program with a
`connector.yaml` manifest, written by you or your agent (TypeScript on the bundled Deno by default;
Python and other languages work with your own interpreter). It converts an export file or fetches from
an API with a key you enter in the app. You approve it once in **Ustawienia > Konektory** (pinned by
content hash); the app then runs it in a macOS sandbox with a timeout and sends its output through the
normal import preview. The contract for authors: [`docs/connectors.md`](docs/connectors.md); tested
examples in [`examples/connectors/`](examples/connectors/). Community connectors are collected in the
[`connectors/`](connectors/README.md) catalog, which ships with the app: your agent can install an
entry for your review, and you still approve it in the app.

---

## Where the data comes from

**CSV import (works right away, no API).** Arrange statements under `statements/<bank>/` (or any
folder) and run `cashu import-dir <folder>` - import takes the bank from the subdir name. Repeated
import is idempotent (dedup by bank transaction id and by content hash). The built-in parsers live in
`packages/domain/src/budget/ingestion/statements/` and banks are entries in a registry
(`packages/domain/src/core/institutions.ts`). Other banks are read through **connectors**, not new
parsers in the app: the built-in parsers are frozen and will move to connectors too (see
[`CONTRIBUTING.md`](CONTRIBUTING.md)).

**Open Banking (Enable Banking, optional).** A free "Restricted Production" tier for live sync (~90
days, re-authorize every 90 days), set up in the app (Settings > Konektory). The hybrid is deliberate:
OB keeps data current, and you backfill history with CSV exports. Step by step:
[`ONBOARDING.md`](ONBOARDING.md).

---

## Data model

Each profile is one encrypted vault: an append-only event log plus views materialized from it
(`packages/store`, spec in `packages/store/spec/events.md`). Events are never edited: a format change is
a new event version with an upcaster, and views are rebuilt from the log when their definition changes.
The domain rules (net worth per currency, transfers by IBAN, amortization, depreciation, FIFO lots,
rules) are pure code in `packages/domain`. Details:
[`docs/agents/data-model.md`](docs/agents/data-model.md).

---

## Development and tests

```bash
corepack enable && pnpm install --frozen-lockfile
pnpm check                           # typecheck, lint, tests (synthetic data only)
pnpm arch:check                      # layers, unused code, catalogs, the architecture guards
pnpm --filter @cashu/desktop dev     # the desktop app on a synthetic demo
```

A pnpm + turbo monorepo: Node 22 (`.nvmrc`), strict ESM TypeScript (`tsconfig.base.json`), vitest for
tests, Biome for lint and format (one dependency and one config file for both jobs, fast enough to run
in every package on every push). Architecture, code map, conventions, and "how to add a feature" -
[`CLAUDE.md`](CLAUDE.md) and [`docs/agents/`](docs/agents/). Releases: a merge to `main` bumps the version and builds the signed release after the owner's
approval ([`docs/releasing.md`](docs/releasing.md)).

**Contributing.** Issues and pull requests are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) and
[`CLAUDE.md`](CLAUDE.md) first, and never include real financial data: tests, fixtures and screenshots
use synthetic data only. Security issues: [`SECURITY.md`](SECURITY.md). Where the project is going:
[`ROADMAP.md`](ROADMAP.md).

---

## Disclaimers

A personal-use tool, provided "as is" (licensed [MIT](LICENSE)). Not financial or investment advice.
CSV formats and Open Banking endpoints drift - an unusual statement may need a small connector tweak
(an agent can handle it from a sample file).
