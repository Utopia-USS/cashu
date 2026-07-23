# ONBOARDING.md — setup guide (the agent walks the user through it)

> **For the user:** open this project in Claude Code (or another agent) and say:
> *"Walk me through the setup following ONBOARDING.md."* The agent will run the
> steps with you. You can also do it by hand — the commands are below.
>
> **For the agent:** this is a script to run *together with the user*. Go step by
> step. After each step, show the result and wait until it works before moving on.
> Ask questions at the points marked 🔀. Follow the safety rules in
> [`AGENTS.md`](AGENTS.md) — **never commit the user's data and never ask for bank
> passwords**.

---

## Step 0 — Prerequisites

Check that the user has:
- **Python 3.12+** (`python3 --version`),
- **Node 18+** and **npm** (`node --version`) — to build the dashboard,
- (optional) **Ollama** — if they want to categorize spending with a local,
  offline LLM.

If something is missing, say how to install it (macOS: `brew install python node
ollama`) and wait.

---

## Step 1 — Environment and install

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
finanse init-db
```

✅ **Verify:** `finanse --help` prints the command list and `data/finanse.db`
exists. Run `pytest` — all tests should pass (they use synthetic data).

---

## Step 2 — Configuration

```bash
cp .env.example .env
```

The defaults are enough to start (local DB, LLM off, Open Banking off). Nothing
needs filling in yet — we come back to `.env` for Open Banking (step 4).

---

## Step 3 — Load data 🔀

Ask the user **where the data comes from**. Two paths (you can do both):

### 3A. CSV import (recommended first — works right away, no API)

The user exports history from their online banking to CSV and arranges the files
under `statements/<bank>/` (the directory is git-ignored — data stays local):

```
statements/mbank/*.csv    statements/erste/*.csv    statements/pekao/*.csv
```

Supported formats (verified): **mBank** (cp1250, `;`, multi-currency),
**Erste/Santander** (UTF-8, no header, positional), **Pekao** (UTF-8, `;`).

> 🔀 **A different bank?** If the user has a bank outside these three, offer to
> write a parser — instructions in [`AGENTS.md`](AGENTS.md) → "Adding a new bank".
> Ask for **one sample file** and analyze the format (encoding, separator,
> columns, where currency/IBAN/balance come from).

```bash
finanse import-dir statements     # bank from the subdir name, idempotent
finanse match-transfers           # pair internal transfers (by IBAN)
finanse stats                     # sanity check: net worth per-currency + cashflow
```

### 3B. Open Banking (live sync) — see step 4

If the user only wants CSV, skip step 4 and go to step 5.

✅ **Verify:** `finanse accounts` shows the accounts and `finanse stats` shows a
sensible net worth. If net worth looks doubled — check whether the same account
got imported twice (CSV gives a bare NRB, OB the full IBAN; merging is by
`iban_key`). Flag it to the user if something is off.

---

## Step 4 — Open Banking (optional, live sync) 🔀

Skip if CSV import is enough for the user. This needs a free **Enable Banking**
account ("Restricted Production" tier).

Guide the user (some steps **they do themselves** — you have no access to their
bank panel or their keys):

1. The user creates an app at <https://enablebanking.com/cp/>, generates an RSA
   key pair, uploads the public key, and saves the **private** key locally to
   `data/enablebanking_private.pem` (this file is git-ignored).
2. In `.env` they set `FINANSE_EB_APP_ID` and (if a different path)
   `FINANSE_EB_KEY_PATH`.
3. In the EB panel they whitelist the redirect
   **`https://localhost:8000/eb/callback`** (must be https) and click "Activate by
   linking accounts".
4. Check the connection:
   ```bash
   finanse eb check
   finanse eb banks --country PL
   ```
5. Authorize + first sync (opens a browser, the user logs into the bank —
   **they enter the password/SCA**, a local server captures the code):
   ```bash
   finanse eb login "mBank" --bank mbank
   finanse eb login "Erste Bank Polska" --bank erste
   ```
6. Later syncs without logging in again (sessions valid ~90 days):
   ```bash
   finanse eb resync
   ```

> ⚠️ **Rate limits:** banks throttle PSD2 hard (`429`). Sync **~once a day**, not
> in a loop. Sync is resilient — one account's error doesn't stop the rest.

---

## Step 5 — Categorize spending 🔀

The PL rules (~420) always run and fire automatically after import. Ask whether the
user wants to add an LLM for unknown merchants:

```bash
finanse categorize                # deterministic rules only (always safe)
finanse categorize --llm          # + LLM for the tail of unknown merchants
```

> 🔀 **Which LLM backend?**
> - **Ollama (default, offline)** — nothing leaves the machine. Requires
>   `ollama serve` + `ollama pull qwen2.5:3b` (or `:7b` for better coverage).
> - **Anthropic (cloud)** — set `FINANSE_CATEGORIZE_LLM_BACKEND=anthropic` and
>   `FINANSE_ANTHROPIC_API_KEY`. Sends **only the merchant-name string** — never
>   IBANs, balances, or names. Confirm with the user that they accept sending
>   merchant names to the cloud before enabling it.

Corrections teach the system: `finanse set-category <merchant> <category>` creates
a durable rule; changing a single transaction's category from the dashboard
survives re-categorization.

---

## Step 6 — Manual positions (optional)

Non-bank assets/liabilities (home, mortgage, car, cash) are added via commands.
Offer them if the user wants a full picture of their net worth:

```bash
finanse add-position "Mieszkanie" --type property --value 730000
finanse add-position "Kredyt hipoteczny" --type mortgage --value 680000
finanse set-loan <id> 680000 6.27 --years 30 --start 2026-08-01   # amortization → simulator
finanse set-vehicle "Auto" 62500 2025-06-16 --rate 15 --floor 8000
finanse cash-add 200 "zakupy" groceries                            # a cash expense
```

(The values above are just format examples — the user enters their own.)

---

## Step 7 — Dashboard

```bash
cd frontend && npm install && npm run build && cd ..
finanse serve                     # http://127.0.0.1:8500
```

Open it in the browser and walk the tabs: **Przegląd** (net worth + chart),
**Wydatki** (where the money goes + drill-down), **Przepływy**, **Subskrypcje**,
**Kredyt**. (The UI is in Polish.) If you have the preview tools — run
`finanse serve` (there is a `.claude/launch.json`) and show the user a screenshot
that it works.

> Dev mode with hot-reload (to edit the dashboard): `finanse serve` plus, separately,
> `cd frontend && npm run dev` (Vite :5173, proxies to the API).

---

## Step 8 — Done. What next?

Tell the user they can now:
- **extend the dashboard** — adding a feature is described in [`AGENTS.md`](AGENTS.md),
- **add their bank** — a CSV parser per [`AGENTS.md`](AGENTS.md),
- **refresh data** — `finanse import-dir statements` (new CSV) or `finanse eb resync` (OB).

Finally, **check `git status`** — if anything under `data/` or `statements/` shows
up as ready to commit, **that's a bug**: stop and fix `.gitignore` before the user
pushes anything.
