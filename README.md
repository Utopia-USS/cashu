<p align="center"><img src="docs/assets/logo-cashu.png" alt="cashU" width="560"></p>

# cashU - a local personal-finance and investing companion

An open-source, local-first app for your money: budget, assets, loans and
investments in one dashboard, plus Claude Code agents that help you set it up and
research your positions. The Python package and the command line are called
`cashu`. cashU started as a fork of [finanse](https://github.com/SynSzakala/finanse) (MIT, the
original copyright is kept in [LICENSE](LICENSE)).

It pulls transactions from Polish banks (**mBank**, **Erste** / former Santander,
**Pekao**) via CSV export and optionally Open Banking, normalizes them to a common
model, deduplicates, detects internal transfers between your own accounts,
categorizes spending, and shows **net worth over time, monthly cashflow, recurring
payments, loans, and asset depreciation** on a web dashboard. Data is kept per
**profile** (you, your partner, the household), and each profile picks the
**modules** it uses (budget, assets, loans, investments). The investments module
keeps you on your own written strategy: rule signals on market data, alerts,
theses and a watchlist, never orders, never price predictions.

> 🔒 **Privacy.** Everything runs **locally**. Your financial data lives in a
> SQLite file in your per-user data dir, outside the repository
> (`~/Library/Application Support/cashU` on macOS, `%APPDATA%\cashU` on
> Windows, `~/.local/share/cashu` on Linux; override with `CASHU_DATA_DIR`),
> so it **never lands in the repository** (statements and `.env` are git-ignored
> too). API keys go to the OS keychain (`cashu secrets set anthropic`). The
> dashboard listens on `127.0.0.1` only and every API call needs a per-launch
> token. Bank passwords never pass through this code - you log in (SCA) yourself
> in the bank's browser. Categorization uses a local offline model by default; the
> optional cloud mode sends **only merchant names**.

> 🌐 **Language.** Code, comments, and docs are in English. The **dashboard UI is
> in Polish** and so are the categorization keywords and LLM prompts - the tool
> targets customers of Polish banks, and those strings are matched against Polish
> transaction text.

Stack: Python 3.12+ · SQLModel/SQLite · Typer (CLI) · FastAPI (API) ·
React + Vite + TypeScript + Recharts (dashboard).

---

## 🚀 Fastest start - with an AI agent

The project is set up so an **agent (e.g. Claude Code) walks you through the whole
setup step by step** - from install, through loading your data, to running the
dashboard.

```bash
git clone https://github.com/Utopia-USS/cashu.git && cd cashu
```

Open the directory in Claude Code (or another file-aware assistant) and say:

> **"Walk me through the setup following ONBOARDING.md."**

The agent reads [`ONBOARDING.md`](ONBOARDING.md), [`AGENTS.md`](AGENTS.md), and
[`CLAUDE.md`](CLAUDE.md), then runs the steps with you, asking questions where a
decision is needed (CSV import or Open Banking, which categorization model, etc.).
The agent knows the safety rules and **won't commit your data**.

---

## 🔧 Manual start (no agent)

```bash
# 1) environment
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"       # exact tested versions: add -c constraints.txt
cashu init-db                # prints where the database lives
cp .env.example .env         # the defaults are enough to start

# 2) drop CSV statements into statements/<bank>/ (mbank | erste | pekao), then:
cashu import-dir statements  # bank from the subdir name, idempotent
                               # (the first import creates the "default" profile)
cashu match-transfers        # pair internal transfers (by IBAN)
cashu categorize             # categories (PL rules; --llm for the tail)

# 3) dashboard
cd frontend && npm install && npm run build && cd ..
cashu serve                  # open the printed http://127.0.0.1:8500/#token=... URL
```

Full guide (including Open Banking, LLM categorization, manual positions) -
[`ONBOARDING.md`](ONBOARDING.md).

**More than one person?** `cashu profiles add "Marta"` creates a second
profile; run commands for it with `cashu --profile marta ...` (or set
`CASHU_PROFILE`), and switch profiles in the dashboard header.

**Investments?** Add a brokerage account and import your history in the cashU
import format ([`docs/import-format.md`](docs/import-format.md)) or with a CSV
column mapping, then write a strategy and run the rules:

```bash
cashu invest accounts add "XTB IKE" --broker xtb --wrapper ike
cashu invest import history.csv --account 1      # --dry-run to preview
cashu invest strategy init                       # strategy.yaml + strategy.md in the data dir
cashu invest run                                 # prices, valuation, rules, signals
cashu invest positions
```

**In the background:** `cashu worker install` schedules a daily run (launchd on
macOS, default 07:30, `--time HH:MM`) of `cashu worker run`: the rules check of
every profile with investments, the bank sync of budget profiles with saved Open
Banking sessions (at most once a day, backing off after a bank rate limit), a
notification for each new signal of the severities your strategy lists under
`notifications.immediate`, and a weekly digest on `notifications.digest_weekday`.
`cashu worker status` shows the last and next run; the log is
`<data dir>/logs/worker.log`.

**Upgrading from a version that kept the database in `data/`?** cashU keeps
using it and says so on every command until you run `cashu migrate-data`, which
copies the database (plus Open Banking sessions and key) into the data dir with a
timestamped backup. An existing database is upgraded automatically (with a backup
in `backups/` first): all its data becomes the `default` profile, with the modules
it already uses switched on. If you run cashU before `migrate-data`, that upgrade
happens in place on `data/finanse.db` (legacy name); its copy from before the upgrade is kept in
the data dir (`backups/cashu-legacy-pre-*.db`) and the notice and `migrate-data`
name it, so deleting `data/` afterwards never loses it.

**Upgrading from finanse (the name before cashU, legacy name)?** The first start of cashU
(the app or any `cashu` command) moves the old data dir (`~/Library/Application
Support/finanse`, legacy name) to `~/Library/Application Support/cashU` and renames its
database to `cashu.db`, unless something still uses it (close the old app first; Ustawienia >
Aplikacja shows a step that could not run). Secrets move from the keychain service `finanse` to
`cashu` (legacy name in the first), and an installed background job is reinstalled under its new
label. The old `finanse` command (legacy name) still works for now and prints a deprecation
line, `FINANSE_*` variables (legacy name) are read when the `CASHU_*` one is not set, and import
documents with the old format ids are accepted. Agent workspaces stay where they are: run
"Aktualizuj workspace" (Ustawienia > Agent AI) or `cashu workspace update` once per profile, and
re-add a Claude Code MCP server registered by hand as `cashu-<slug>` (`claude mcp add cashu-<slug> -- cashu mcp --profile <slug>`).

---

## 🖥️ Installing the macOS app

cashU can also run as a normal Mac app: `cashU.app` with its own window and
icon, no terminal. It is the same code and the same data dir as the CLI, so the
app and `cashu ...` commands see the same profiles.

**Build it** (macOS, Python 3.12+, Node.js, Xcode command line tools):

```bash
scripts/build_macos.sh          # SPA (npm ci + build), icon, PyInstaller bundle
                                # -> build/macos/dist/cashU.app and a .zip next to it
```

The script builds the dashboard in a copy of `frontend/` and installs the Python
side into its own venv under `build/macos/`, so your dev setup stays untouched.
`--dmg` also makes a disk image, `--clean` starts from scratch.

**Install it:** drag `build/macos/dist/cashU.app` to `/Applications` (or open
the `.dmg`) and start it from Launchpad or Finder. The first launch creates the
database in the data dir (or keeps using the one you already have) and opens the
profile wizard. Closing the window quits the app, local server included.

**Gatekeeper:** a build without a signature runs on the Mac that built it. Copied
to another Mac (download, AirDrop), macOS blocks it as "from an unidentified
developer": open it once, then confirm in System Settings > Privacy & Security >
"Open Anyway" (only do that for a build you made yourself). Signed and notarized
builds open normally; the script signs and notarizes when these are set:

```bash
export DEVELOPER_ID_APPLICATION="Developer ID Application: Your Name (TEAMID)"
export NOTARY_KEYCHAIN_PROFILE=cashu-notary   # xcrun notarytool store-credentials cashu-notary ...
scripts/build_macos.sh
```

Without them the script says that it skipped signing. No certificate, password
or key is stored in the repo: the identity stays in your keychain.

**One binary for everything.** `cashU.app/Contents/MacOS/cashu` takes the
usual commands, so the background worker and the AI agents use the app too:

- Settings > Praca w tle installs the daily worker pointing at the app (move the
  app to `/Applications` first; a copy macOS runs from a temporary location is
  refused);
- Settings > Agent AI shows the `claude mcp add ...` line and the Claude Desktop
  config with the app's path, e.g.
  `/Applications/cashU.app/Contents/MacOS/cashu mcp --profile <slug>`;
- `.../MacOS/cashu skills install` copies the setup skills (`/budget-setup`,
  `/investments-setup`, ...) to `~/.claude/skills` for use without a checkout.

From a checkout the same window is `pip install -e ".[desktop]"` and
`cashu app`. Only one window runs per data dir; a second start brings the first
one to the front. The app log is `<data dir>/logs/app.log` (`CASHU_APP_DEBUG=1`
adds the request log and the WebKit inspector). A Windows build is planned: see
`packaging/windows/cashu-windows.spec`.

---

## What it does

- **Net worth over time** - per-currency (never mixes currencies), broken down by
  asset/liability class (cash, property, vehicle, mortgage, loan), with a
  windowed/scrollable chart and a zoomable Y axis.
- **Monthly cashflow** - income vs expenses, excluding transfers within your own
  net worth.
- **Where the money goes** - spending categorization (25 categories, ~420 PL rules
  + optional LLM), drill-down to transactions with corrections that teach the
  system.
- **Recurring payments** - subscription detection.
- **Loans** - any number per profile; annuity amortization (payment, schedule,
  outstanding debt, total interest); the net-worth balance decreases over time,
  and a balance from a bank statement takes over from its date. Installments are
  recognised as loan repayments, never as subscriptions.
- **Assets and cash** - car depreciation, manual positions, cash tracking.
- **Investments** - brokerage accounts, FIFO positions valued with stored prices
  and NBP rates, allocation vs your `strategy.yaml`, rule signals and a decision
  journal; the portfolio counts toward net worth in each account's currency.

The dashboard shows **Przegląd** (overview) plus a tab per enabled module:
**Wydatki · Przepływy · Subskrypcje** (budget), **Kredyty** (loans) and
**Inwestycje** (investments), with **Ustawienia** (settings) on the right. The UI is
in Polish.

---

## AI agents (MCP and skills)

Every profile has its own local MCP server (`cashu mcp --profile <slug>`), so
Claude Code or Claude Desktop can read and propose changes without ever touching
the database. The privacy level is per profile and **strict by default**: shares
and percentages, no amounts, never account numbers or other identifiers (it
covers what the app gives the agent; a file you hand the agent yourself is your
call). Agent writes are proposals you approve in the app, and the app runs only
connectors you approved (below).

```bash
claude mcp add cashu-<slug> -- cashu mcp --profile <slug>   # once per profile
```

The repo ships Claude Code skills for each module (`/budget-setup`,
`/assets-setup`, `/loans-setup`, `/investments-setup`) and for investments work
(`/import-builder` for unsupported broker exports, `/extension-builder` for custom
rules, `/market-research` for dated, sourced research notes). Details:
[`AGENTS.md`](AGENTS.md).

---

## Connectors (any bank or broker, no fork)

A bank or broker cashU does not read can be added with a **connector**: a small
program in any language with a `connector.yaml` manifest, written by you or your
agent. It converts an export file or fetches from an API with a key you enter in
the app. You approve it once in **Ustawienia > Konektory** (pinned by content
hash); the app then runs it in a macOS sandbox with a timeout and sends its output
through the normal import preview. The contract for authors:
[`docs/connectors.md`](docs/connectors.md); tested examples in
[`examples/connectors/`](examples/connectors/).

---

## Where the data comes from

**CSV import (works right away, no API).** Arrange statements under
`statements/<bank>/` - import takes the bank from the subdir name. Repeated import
is idempotent (dedup by `bank_transaction_id` and by content hash). Parsers are
thin configs on a shared engine (`src/cashu/modules/budget/ingestion/csv_import/`)
and banks are entries in a registry (`src/cashu/core/institutions.py`) -
**adding another bank is easy** (see [`AGENTS.md`](AGENTS.md)).

**Open Banking (Enable Banking, optional).** A free "Restricted Production" tier
for live sync (~90 days, re-authorize every 90 days). The hybrid is deliberate: OB
keeps data current, and you backfill history with CSV exports. Step-by-step config
in [`ONBOARDING.md`](ONBOARDING.md).

---

## Data model

| table | role |
|---|---|
| `profiles`, `profile_modules` | profiles (person / household) and the modules each one uses |
| `accounts` | accounts of a profile (one physical account = one record; Santander and Erste are the same account) |
| `transactions` | normalized signed transactions (+income / −expense), with a dedup hash and transfer group |
| `balances` | balance snapshots over time - the basis for net worth |
| `category_rules` | learned merchant → category rules (per profile) |
| `import_batches` | audit of every import/sync |

Plus the `Loan` (loan amortization, many per profile) and `Depreciation` (asset
depreciation) models, and the investments module's `inv_*` tables (instruments,
prices, FX rates, broker transactions, signals, decisions, theses). Schema changes are Alembic migrations
(`src/cashu/core/migrations/`).

---

## Updates and versions

Every push to `main` raises the version: a GitHub Action
(`.github/workflows/bump-version.yml`) bumps the patch number in `pyproject.toml`
and `src/cashu/__init__.py` and commits it back. Put `[minor]` or `[major]` in a
commit message for a bigger step, or `[skip bump]` to skip it; a push that changes
the version by hand keeps that version. Pull after pushing, since `main` gains the
bump commit.

The app checks `pyproject.toml` on `main` at launch and shows a small notice in the
bottom-left corner while a newer version exists, with a link to the changes. It
never downloads or installs anything: update with `git pull` and a rebuild
(`scripts/build_macos.sh`, or `npm run build` in `frontend/` for `cashu serve`).
`CASHU_UPDATE_REPO` / `CASHU_UPDATE_BRANCH` point the check at another fork,
`CASHU_UPDATE_CHECK=false` turns it off.

---

## Development and tests

```bash
pytest                               # tests run on synthetic data
cd frontend && npm run dev           # dashboard with hot-reload (proxies /api → :8500)
```

Architecture, code map, conventions, and "how to add a bank / feature" -
[`AGENTS.md`](AGENTS.md).

**Contributing.** Issues and pull requests are welcome. Read
[`AGENTS.md`](AGENTS.md) first, and never include real financial data: tests,
fixtures and screenshots use synthetic data only.

---

## Disclaimers

A personal-use tool, provided "as is" (licensed [MIT](LICENSE)). Not financial or
investment advice. CSV formats and Open Banking endpoints drift - an unusual
statement may need a small parser tweak (an agent can handle it from a sample file).
