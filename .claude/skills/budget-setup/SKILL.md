---
name: budget-setup
description: >
  Use when the user wants to start with cashU, connect or import their bank accounts, set up the home
  budget, or clean up spending categories.
  Applicability - POSITIVE: budget module setup for one profile: app check, banks, CSV vs Open
  Banking (Enable Banking), categorization backend (Ollama vs Anthropic), first categorization pass via
  MCP, sanity check.
  Applicability - NEGATIVE: NOT broker exports (import-builder), manual assets like a flat or a car
  (assets-setup), loans and mortgages (loans-setup) or investment accounts and strategy
  (investments-setup).
  Triggers: /budget-setup, "skonfiguruj budżet", "podłącz bank", "zaimportuj wyciągi", "wgraj CSV z
  banku", "Open Banking", "popraw kategorie wydatków", "przeprowadź mnie przez instalację".
---

# budget-setup: banks, import and categories

You walk the user through the budget module step by step (the same steps as the cashU onboarding
guide; everything you need is in this file and its references). After each step show the result and
wait until it works before moving on. Ask at the decision points (marked "Decision" below).
Conversation in the owner's language (the app language the cashU MCP server names; Polish when unsure), files in English, regular hyphens only.

## Relationship to the workspace

| The workspace CLAUDE.md and MCP server own | This skill adds |
|---|---|
| privacy level, boundaries, the MCP tool list, where files go | the budget setup order and its decision points (banks, CSV vs Open Banking, LLM backend) |
| which profile the workspace serves | budget-specific privacy rules: which `cashu` commands only the user runs |
| the `cashu` command of this install (the app's launcher) | supported bank formats, Open Banking setup, the categorization pass and category keys |

## Problem -> reference mapping

| Task / question | Start with |
|---|---|
| First session in a new workspace | this file, step 0 |
| Where does the user stand, is MCP connected | this file, step 1 |
| Getting the app running, the `cashu` command, data from the older Python app | [`references/install-workflow.md`](references/install-workflow.md), step 2 |
| One person or a household, profiles | this file, step 3 |
| Which banks are supported, a bank cashU does not read yet | [`references/bank-import-workflow.md`](references/bank-import-workflow.md), step 4 |
| Import CSV statements, many files at once, internal transfers | [`references/bank-import-workflow.md`](references/bank-import-workflow.md), step 5 |
| Open Banking with Enable Banking | [`references/bank-import-workflow.md`](references/bank-import-workflow.md), step 6 |
| Ollama vs Anthropic for unknown merchants | [`references/categorization-workflow.md`](references/categorization-workflow.md), step 7 |
| Categorize the most frequent unknown merchants, category keys | [`references/categorization-workflow.md`](references/categorization-workflow.md), step 8 |
| Do the numbers look sane, doubled net worth | this file, step 9 |
| Finish, git-ignore check | [`references/install-workflow.md`](references/install-workflow.md), step 10 |

## Non-negotiable

Privacy and boundaries (say the first two lines at the start):

- Data reaches you only through the profile's MCP server `cashu-<slug>`; every call is logged in the
  app (Ustawienia > Agent AI (MCP)). Read the privacy level from `profile_overview` (`privacy`: `strict` or
  `amounts`):
  - **Ścisły (strict, default):** category shares, top merchants with shares, savings rate in %,
    merchant names, dates. No amounts, account numbers or names.
  - **Z kwotami (amounts):** also amounts in the account currency. Still no IBANs, account numbers or
    personal data.
  - In both levels accounts appear as generated labels ("<institution> <type> <n>") and payees that
    look like private persons (transfers to people) as opaque `payee:<hash>` references.
- Never ask for bank logins, passwords, SCA codes, API keys, IBANs or the profile's recovery phrase.
  The user logs in only in the bank's own page; keys (Enable Banking, Anthropic) are entered only in
  the app. If the user pastes a secret or an IBAN, do not repeat or store it.
- Never open the cashU data dir (vaults, backups, Open Banking sessions, keys). The privacy level covers what the
  MCP tools give you; a statement the user hands you themselves may be read for the task they asked for
  (values stay in the conversation, never in notes or files; account numbers, IBANs and names are never
  repeated or written anywhere). Never run commands that print account names, file names, balances or
  transactions (`cashu import-dir`, `import-csv`, `accounts`, `stats`, `eb check`, `eb sessions`,
  `eb resync`). Give them to the user to run in their own terminal, not with `!` in this
  session (that would put the output into the conversation), and ask only whether it worked or what
  kind of error appeared.
- You may run commands that print no personal data: `cashu --help`, `cashu profiles list`,
  `cashu match-transfers` and `cashu categorize` (counts only), `git check-ignore` (step 10).
- Do not take screenshots of the app with real data; the user looks at it themselves.
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

## Flow

**0. Workspace layout (first session only).** If this workspace has no
`notes/workspace-setup.md` yet, run step 1 of `/workspace-setup` first (a short recommendation
of the agent layout and why it helps), then continue here. Skip it when the file exists or the
user declines.

### Step 1 - Where are we

1. Is cashU.app installed and has it been opened once? If not, step 2 first. `cashu` in the commands
   below is the command named in the workspace's `CLAUDE.md` (the app's launcher,
   `~/Library/Application Support/cashU/bin/cashu`); the user may alias it as `cashu`.
2. Is the profile's MCP server connected? In the profile's agent workspace (its `CLAUDE.md` names the
   profile) it is configured in `.mcp.json`. Otherwise the profile must exist first (step 3), then the
   user creates the workspace (Ustawienia > Agent AI (MCP), or `cashu --profile <slug> workspace init`) and
   starts Claude Code in it (or runs the `claude mcp add` line shown there and restarts Claude Code);
   they re-run `/budget-setup` and `setup_status("budget")` shows where to continue. Steps 2-7 work
   without MCP; the categorization pass (step 8) and the checks (step 9) need it.
3. If several `cashu-*` servers are connected, ask which profile and use only that one.

### Step 2 - The app

The user installs cashU.app and opens it once (nothing else to install; Ollama is optional for step
7); data from the older Python app is brought over by you, the agent (`/import-builder`, section
"Old cashU (Python) data"); then the `cashu` alias. Details:
[`references/install-workflow.md`](references/install-workflow.md).

### Step 3 - Profile

Decision: one person or several? Each profile is its own encrypted vault, created in the app's
wizard (or `cashu profiles add "<name>" --modules budget`; the name can be anything, e.g. "dom"). The
app shows a 24-word recovery phrase: the user writes it down outside the computer; never ask for it.
Several people: one profile each, and every later command takes `cashu --profile <slug> ...`
(`cashu profiles list` shows the slugs).

### Steps 4-6 - Banks, CSV import, Open Banking

Follow [`references/bank-import-workflow.md`](references/bank-import-workflow.md):

- **Step 4 - Which banks (Decision):** CSV for mBank, Erste / former Santander, Pekao; Bank
  Millennium and Revolut via Open Banking only; any other bank via Open Banking or a connector
  (`/import-builder`).
- **Step 5 - CSV import (recommended first):** a supported bank: the user runs `import-dir` on the
  workspace's `inbox/statements/`; you may run `match-transfers`. For a bank cashU does not read yet
  ask once: file with values, or the recommended connector written without seeing values.
- **Step 6 - Open Banking (optional, Decision):** the user sets up Enable Banking in the app and logs
  in at the bank themselves; sync about once a day (the daily job, or `eb resync`).

### Steps 7-8 - Categorization

Follow [`references/categorization-workflow.md`](references/categorization-workflow.md):

- **Step 7 - Categorization backend (Decision):** Ollama (default, offline) or Anthropic (cloud,
  merchant names only, explicit consent first); then you may run `categorize` (counts only).
- **Step 8 - First categorization pass (MCP):** `uncategorized_merchants(20)`, propose in batches of
  5-8, never guess unknown merchants or `payee:<hash>` persons, `set_merchant_category` for each
  confirmed one. Installments go to `loans`, never to `subscriptions`.

### Step 9 - Sanity check (MCP)

- `setup_status("budget")`: every step done or explained.
- `spending_breakdown` for the last full month: do the top categories and merchants look plausible to
  the user? `cashflow_summary(3)`: savings rate and deficit months plausible?
- Net worth doubled? In strict mode you cannot see amounts: ask the user to look at the overview
  (Przegląd) in the app. A doubled value usually means the same account was imported twice (CSV gives a bare NRB,
  Open Banking the full IBAN; accounts merge by `iban_key`): flag it.

### Step 10 - Finish

The user walks the app (overview, budget page, Settings). If statements sit inside a git repository,
run the `git check-ignore` loop there ([`references/install-workflow.md`](references/install-workflow.md));
any `NOT IGNORED` line stops everything until `.gitignore` is fixed.

Next: manual assets with `/assets-setup`, loans with `/loans-setup`, investing with `/investments-setup`.

## References

| File | Style | Impact | Description |
|---|---|---|---|
| [`references/bank-import-workflow.md`](references/bank-import-workflow.md) | workflow | CRITICAL | steps 4-6: supported banks, CSV import, Open Banking via Enable Banking |
| [`references/categorization-workflow.md`](references/categorization-workflow.md) | workflow | HIGH | steps 7-8: LLM backend, first categorization pass, category keys |
| [`references/install-workflow.md`](references/install-workflow.md) | workflow | MEDIUM | steps 2 and 10: the app, the `cashu` command, data from the Python app, git-ignore check |

## See also

- `/workspace-setup` - first session in a new workspace: the recommended agent layout (step 0).
- `/import-builder` - a bank cashU does not read yet (connector), or broker exports.
- `/assets-setup` - a flat, plot, car or other manually valued asset.
- `/loans-setup` - mortgages and loans, so installments stop counting as subscriptions.
- `/investments-setup` - investing: brokerage accounts and a written strategy.

## Self-audit checklist

Before telling the user it is done:
1. The first two privacy lines were said and the privacy level from `profile_overview` was stated.
2. You ran no command that prints account names, balances or transactions; the user ran those.
3. No IBAN, account number, name or secret was repeated or written to a note or file.
4. Every `set_merchant_category` was confirmed by the user first; no unknown merchant or
   `payee:<hash>` was guessed.
5. `setup_status("budget")` shows every step done or explained, and the sanity check (step 9) found no
   doubled account, or it was flagged.
6. Statements inside a git repository: the `git check-ignore` loop printed nothing there.
