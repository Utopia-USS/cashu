---
name: budget-setup
description: Guided setup of the finanse home budget module for one profile - install check, choosing banks, CSV export vs Open Banking (Enable Banking), the categorization backend (local Ollama vs Anthropic), a first categorization pass of the most frequent unknown merchants through the profile's finanse MCP server, and a check that the numbers look sane. Use when the user wants to start with finanse, connect or import their bank accounts, set up the budget, or clean up spending categories. Triggers on /budget-setup and on Polish requests such as "skonfiguruj budżet", "podłącz bank", "zaimportuj wyciągi", "wgraj CSV z banku", "Open Banking", "popraw kategorie wydatków", "przeprowadź mnie przez instalację". Not for broker exports (import-builder), manual assets (assets-setup) or loans (loans-setup).
---

# budget-setup: banks, import and categories

You walk the user through the budget module step by step (the same steps as the finanse onboarding
guide; everything you need is in this file).
After each step show the result and wait until it works before moving on. Ask at the decision points
(marked "Decision" below). Conversation in Polish, files in English, regular hyphens only.

## Privacy and boundaries (say the first two lines at the start)

- Data reaches you only through the profile's MCP server `finanse-<slug>`; every call is logged in the
  app (Ustawienia > Agent AI). Read the privacy level from `profile_overview` (`privacy`: `strict` or
  `amounts`):
  - **Ścisły (strict, default):** category shares, top merchants with shares, savings rate in %,
    merchant names, dates. No amounts, account numbers or names.
  - **Z kwotami (amounts):** also amounts in the account currency. Still no IBANs, account numbers or
    personal data.
  - In both levels accounts appear as generated labels ("<institution> <type> <n>") and payees that
    look like private persons (transfers to people) as opaque `payee:<hash>` references.
- Never ask for bank logins, passwords, SCA codes, API keys or IBANs. The user logs in only in the
  bank's own page; keys are typed only into hidden prompts in the user's own terminal
  (`finanse secrets set anthropic`). If the user pastes a secret or an IBAN, do not repeat or store it.
- Never open statement CSVs, `finanse.db`, backups or Open Banking session files. Never run commands
  that print account names, file names, balances or transactions (`finanse import-dir`, `import-csv`,
  `accounts`, `stats`, `eb login`, `eb check`, `eb sessions`, `eb resync`). Give them to the user to run
  in their own terminal, not with `!` in this session (that would put the output into the
  conversation), and ask only whether it worked or what kind of error appeared.
- You may run commands that print no personal data: version checks, `pip install`, `pytest` (synthetic
  data), `npm run build`, `finanse --help`, `finanse match-transfers` and `finanse categorize` (counts
  only), `git check-ignore` (step 9).
- Do not take screenshots of the dashboard with real data; the user opens it in their browser.
- Never run `eb resync` or `reclassify` in a loop: banks throttle PSD2 (429). Sync about once a day.
- Never bypass bot protection (CAPTCHA, JS challenges) when looking something up online.
- The categorization rule of the project stays: a cloud LLM only ever gets the merchant name, never
  IBANs, balances or names.

## MCP tools used

| tool | when |
|---|---|
| `profile_overview` | start: modules, privacy level, data freshness |
| `setup_status("budget")` | start and after each step: bank account, first import, categories, transfers |
| `uncategorized_merchants(limit)` | first categorization pass |
| `set_merchant_category(merchant, category)` | after the user confirms a category (a learned rule for this profile) |
| `spending_breakdown(period)`, `cashflow_summary(months)`, `recurring_payments` | sanity check at the end |
| `networth_breakdown` | sanity check (per currency shares) |

## Step 0 - Where are we

1. How does finanse run? **Packaged app** (Finanse.app): nothing to install, skip steps 1 and 9's
   build; `finanse` in the commands below is the CLI named in the workspace's `CLAUDE.md` (the app's
   binary). **Source checkout**: `finanse --help` works in the project's venv; if not, steps 1-2 first.
2. Is the profile's MCP server connected? In the profile's agent workspace (its `CLAUDE.md` names the
   profile) it is configured in `.mcp.json`. Otherwise the profile must exist first (step 2), then the
   user creates the workspace (Ustawienia > Agent AI, or `finanse workspace init --profile <slug>`) and
   starts Claude Code in it (or runs the `claude mcp add` line shown there and restarts Claude Code);
   they re-run `/budget-setup` and `setup_status("budget")` shows where to continue. Steps 1-6 work
   without MCP; the categorization pass (step 7) and the checks (step 8) need it.
3. If several `finanse-*` servers are connected, ask which profile and use only that one.

## Step 1 - Prerequisites and install (source checkout only)

Check `python3 --version` (3.12+), `node --version` (18+, for the dashboard), optionally `ollama`.
Missing on macOS: `brew install python node ollama`. Then:

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
finanse init-db          # prints the database location in the per-user data dir
pytest                   # synthetic data only
```

Older checkout with `data/finanse.db`: every command prints a notice; the user runs `finanse
migrate-data` (copies the DB, Open Banking sessions and key into the data dir with a backup).

## Step 2 - Configuration and profile

Source checkout: `cp .env.example .env`; the defaults are enough to start. Decision: one person or several? One person:
the first import creates the `default` profile (or the dashboard wizard creates the first profile).
Several: one profile each (`finanse profiles add "<name>" --modules budget`; the name can be anything,
e.g. "dom"), and every later command takes `finanse --profile <slug> ...` (or `FINANSE_PROFILE` in `.env`).

## Step 3 - Which banks (Decision)

Ask which banks the user has. Supported CSV formats (verified): **mBank** (cp1250, `;`,
multi-currency), **Erste / former Santander** (UTF-8, no header, positional), **Pekao** (UTF-8, `;`).
Bank Millennium: Open Banking only for now (no CSV parser yet).

A different bank:
- Open Banking, if Enable Banking lists it (`finanse eb banks --country PL` after step 5 is configured);
- or a new CSV parser: a code change in a finanse source checkout (its developer guide, section
  "Adding a new bank"). You need the format, not the data: ask the
  user for a **synthetic** sample (the real header line plus 2-3 rows with invented values, same
  encoding and separator). Never ask for a real statement.

## Step 4 - CSV import (recommended first)

The user exports history from online banking to CSV and puts the files in one folder per bank: in
the agent workspace `inbox/statements/<bank>/` (Claude Code's file tools are denied in `inbox/`), in a
source checkout `statements/<bank>/` (git-ignored); bank folders `mbank`, `erste`, `pekao`. The user
runs in their own terminal, from the workspace (or the checkout):

```bash
finanse --profile <slug> import-dir inbox/statements   # checkout: import-dir statements; idempotent
```

Then you may run `finanse --profile <slug> match-transfers` (pairs internal transfers by IBAN; prints a
count). Internal transfers are matched by counterparty IBAN only; you never need to know an IBAN.

## Step 5 - Open Banking (optional, Decision)

Skip if CSV is enough. Needs a free Enable Banking account ("Restricted Production"). The user does
these themselves (you have no access to their bank panel or keys):

1. Create an app at <https://enablebanking.com/cp/>, generate an RSA key pair, upload the public key,
   save the private key as `enablebanking_private.pem` in the data dir (next to `finanse.db`, outside
   the repo).
2. In `.env`: `FINANSE_EB_APP_ID` (and `FINANSE_EB_KEY_PATH` if the key is elsewhere). The user edits it.
3. In the EB panel: whitelist the redirect `https://localhost:8000/eb/callback` and click "Activate by
   linking accounts".
4. In their terminal: `finanse eb check`, `finanse eb banks --country PL`, then
   `finanse --profile <slug> eb login "mBank" --bank mbank` (the browser opens; they log in at the bank
   and confirm SCA there).
5. Later: `finanse eb resync` about once a day (sessions last ~90 days, per profile; `--add-session`
   keeps two sessions of one bank in a household profile).

## Step 6 - Categorization backend (Decision)

The ~420 Polish rules always run after import. For the tail of unknown merchants, an LLM is optional:

- **Ollama (default, offline):** nothing leaves the machine. `ollama serve`, `ollama pull qwen2.5:3b`
  (or `:7b` for better coverage).
- **Anthropic (cloud):** `FINANSE_CATEGORIZE_LLM_BACKEND=anthropic` in `.env`, and the user stores the
  key with `finanse secrets set anthropic` in their own terminal (hidden prompt). Sends only the
  merchant-name string. Confirm explicitly that the user accepts sending merchant names to the cloud
  before enabling it.

Then you may run `finanse --profile <slug> categorize` or `categorize --llm` (prints counts only).

## Step 7 - First categorization pass (MCP)

1. `uncategorized_merchants(20)`: merchant names with transaction counts, most frequent first.
2. Propose a category for each from the list below, in batches of 5-8, as a table "merchant ->
   proposed category"; let the user accept, change or skip each (question tool with options works
   well). A merchant the user does not recognize is skipped, never guessed.
   `payee:<hash>` entries are private persons: do not guess who it is and do not ask for the name.
   Skip them, or let the user categorize them in the Wydatki tab where they see the real payee;
   `set_merchant_category` accepts the reference only if the user tells you the category for it.
3. For each confirmed one: `set_merchant_category(merchant, category)`. It creates a learned rule for
   this profile that wins over the built-in rules (same as `finanse set-category` or changing the
   category in the Wydatki tab).
4. Repeat until the user stops or the list is short. Re-check `setup_status("budget")`.

Category keys (label shown in the app): `groceries` Spożywcze, `dining` Gastronomia, `transport`
Transport, `fuel` Paliwo, `car` Auto, `housing` Mieszkanie/Czynsz, `loans` Raty kredytów, `utilities`
Media/Telekom, `health` Zdrowie/Apteka, `shopping` Zakupy, `entertainment` Rozrywka, `subscriptions`
Subskrypcje, `travel` Podróże, `education` Edukacja, `personal_care` Higiena/Uroda, `gifts`
Prezenty/Darowizny, `cash` Gotówka, `fees` Opłaty bankowe, `taxes` Podatki, `other` Inne,
`income_salary` Pensja, `income_refund` Zwroty, `income_other` Inne przychody, `transfer` Przelew
własny, `cash_withdrawal` Wypłata gotówki. The source of truth is the app's category list:
`uncategorized_merchants` lists the valid keys and `set_merchant_category` rejects unknown ones.

Loan and mortgage installments belong to `loans` (the loans module recognises them; see
`loans-setup`), never to `subscriptions`.

## Step 8 - Sanity check (MCP)

- `setup_status("budget")`: every step done or explained.
- `spending_breakdown` for the last full month: do the top categories and merchants look plausible to
  the user? `cashflow_summary(3)`: savings rate and deficit months plausible?
- Net worth doubled? In strict mode you cannot see amounts: ask the user to look at Przegląd in the
  dashboard. A doubled value usually means the same account was imported twice (CSV gives a bare NRB,
  Open Banking the full IBAN; accounts merge by `iban_key`): flag it.

## Step 9 - Dashboard and finish

Packaged app: the user opens Finanse.app. Source checkout:

```bash
cd frontend && npm install && npm run build && cd ..
finanse serve            # http://127.0.0.1:8500 (127.0.0.1 only, per-launch token)
```

The user opens it and walks the tabs (Przegląd, Wydatki, Przepływy, Subskrypcje). Opening an `/api/...`
URL directly answers 401, which is expected.

Source checkout only: finally check that user data cannot be committed (prints nothing when all is
well):

```bash
for p in data/finanse.db statements/mbank/x.csv .env key.pem; do git check-ignore -q "$p" || echo "NOT IGNORED: $p"; done
```

Any `NOT IGNORED` line: stop and fix `.gitignore` before the user commits anything.

Next: manual assets with `/assets-setup`, loans with `/loans-setup`, investing with `/investments-setup`.
