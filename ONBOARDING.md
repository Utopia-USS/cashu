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
cashu init-db
```

✅ **Verify:** `cashu --help` prints the command list and `cashu init-db`
prints the database location in the per-user data dir (macOS:
`~/Library/Application Support/cashU/cashu.db`; Windows: `%APPDATA%\cashU`;
set `CASHU_DATA_DIR` to use another folder). Run `pytest`: all tests should pass
(they use synthetic data in temporary folders).

> 🔀 **Upgrading an older checkout?** If the user already has `data/finanse.db` (legacy name)
> from an earlier version, every command prints a notice and keeps using it. Run
> `cashu migrate-data`: it copies the database, Open Banking sessions and key
> into the data dir and keeps a timestamped backup (the user deletes `data/`
> after checking the dashboard). The schema upgrade (also automatic on any
> command) backs the database up into `backups/` first and puts all existing data
> into one profile, `default`. Run before `migrate-data`, it upgrades
> `data/finanse.db` (legacy name) in place; the copy from before that upgrade goes to the data
> dir (`backups/cashu-legacy-pre-*.db`), and the notice and `migrate-data` say
> where it is.

---

## Step 2 — Configuration

```bash
cp .env.example .env
```

The defaults are enough to start (local DB, LLM off, Open Banking off). Nothing
needs filling in yet — we come back to `.env` for Open Banking (step 4).

> 🔀 **One person or several?** Data is kept per **profile** (a person or a
> household). For a single user nothing is needed: the first import creates the
> `default` profile. For several people, create one profile each and pass it to
> every command (or set `CASHU_PROFILE` in `.env`):
> ```bash
> cashu profiles add "Jan"          # -> slug jan
> cashu profiles add "Marta" --modules budget
> cashu --profile marta import-dir statements-marta
> cashu profiles list
> ```
> The dashboard's first launch can also create the first profile (wizard).

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

> 🔀 **A different bank?** If the user has a bank outside these three, the
> preferred way is a **connector** that the owner approves once in the app
> (Ustawienia > Konektory) and the app then runs itself: the `/import-builder`
> skill writes it, the contract is [`docs/connectors.md`](docs/connectors.md).
> Ask once whether the user hands you the statement with values or wants the
> blind route (you see only its masked structure). Alternatively write a parser
> and add the bank to the registry - instructions in [`AGENTS.md`](AGENTS.md) →
> "Adding a new bank" (test fixtures synthetic).

```bash
cashu import-dir statements     # bank from the subdir name, idempotent
cashu match-transfers           # pair internal transfers (by IBAN)
cashu stats                     # sanity check: net worth per-currency + cashflow
```

### 3B. Open Banking (live sync) — see step 4

If the user only wants CSV, skip step 4 and go to step 5.

✅ **Verify:** `cashu accounts` shows the accounts and `cashu stats` shows a
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
   key pair, uploads the public key, and saves the **private** key locally as
   `enablebanking_private.pem` in the data dir (next to `cashu.db`, outside the
   repo).
2. In `.env` they set `CASHU_EB_APP_ID` and (if a different path)
   `CASHU_EB_KEY_PATH`.
3. In the EB panel they whitelist the redirect
   **`https://localhost:8000/eb/callback`** (must be https) and click "Activate by
   linking accounts".
4. Check the connection:
   ```bash
   cashu eb check
   cashu eb banks --country PL
   ```
5. Authorize + first sync (opens a browser, the user logs into the bank —
   **they enter the password/SCA**, a local server captures the code):
   ```bash
   cashu eb login "mBank" --bank mbank
   cashu eb login "Erste Bank Polska" --bank erste
   ```
6. Later syncs without logging in again (sessions valid ~90 days):
   ```bash
   cashu eb resync
   ```
   Sessions are saved per profile (`cashu --profile marta eb login ...` for
   another person; `cashu eb sessions` lists them). A new login replaces the
   profile's session of that bank; `--add-session` keeps both (e.g. two people
   with mBank in one household profile).

> ⚠️ **Rate limits:** banks throttle PSD2 hard (`429`). Sync **~once a day**, not
> in a loop. Sync is resilient — one account's error doesn't stop the rest.

---

## Step 5 — Categorize spending 🔀

The PL rules (~420) always run and fire automatically after import. Ask whether the
user wants to add an LLM for unknown merchants:

```bash
cashu categorize                # deterministic rules only (always safe)
cashu categorize --llm          # + LLM for the tail of unknown merchants
```

> 🔀 **Which LLM backend?**
> - **Ollama (default, offline)** — nothing leaves the machine. Requires
>   `ollama serve` + `ollama pull qwen2.5:3b` (or `:7b` for better coverage).
> - **Anthropic (cloud)** - set `CASHU_CATEGORIZE_LLM_BACKEND=anthropic` and let
>   the user store the key in the OS keychain with `cashu secrets set anthropic`
>   (hidden prompt; they type it, you never see it). `CASHU_ANTHROPIC_API_KEY`
>   in `.env` still works as a fallback (CI/dev). Sends **only the merchant-name
>   string**, never IBANs, balances, or names. Confirm with the user that they
>   accept sending merchant names to the cloud before enabling it.

Corrections teach the system: `cashu set-category <merchant> <category>` creates
a durable rule; changing a single transaction's category from the dashboard
survives re-categorization.

---

## Step 6 — Manual positions (optional)

Non-bank assets/liabilities (home, mortgage, car, cash) are added via commands.
Offer them if the user wants a full picture of their net worth:

```bash
cashu add-position "Mieszkanie" --type property --value 730000
cashu loans add "Kredyt hipoteczny" --type mortgage --principal 680000 --rate 6.27 \
    --years 30 --start 2026-08-01                                   # amortization → simulator
cashu loans add "Kredyt samochodowy" --principal 60000 --rate 8.9 --months 72 --start 2025-03-01
cashu loans set-payment 1 --text "RATA KREDYTU"                   # recognise its installments
cashu loans set-balance 1 652000 --date 2026-09-30                # a figure from a bank statement
cashu set-vehicle "Auto" 62500 2025-06-16 --rate 15 --floor 8000
cashu cash-add 200 "zakupy" groceries                            # a cash expense
```

(The values above are just format examples - the user enters their own.) A
profile can have any number of loans (`cashu loans list`). The older
`add-position ... --type mortgage` + `set-loan <account id> ...` pair still works.

---

## Step 7 — Dashboard

```bash
cd frontend && npm install && npm run build && cd ..
cashu serve                     # prints http://127.0.0.1:8500/#token=...
```

Open it in the browser and walk the tabs: **Przegląd** (net worth + chart),
**Wydatki** (where the money goes + drill-down), **Przepływy**, **Subskrypcje**,
**Kredyt**. (The UI is in Polish.) If you have the preview tools — run
`cashu serve` (there is a `.claude/launch.json`) and show the user a screenshot
that it works.

The server listens on `127.0.0.1` only (`CASHU_HOST` / `CASHU_PORT` or
`--host` / `--port` to change it) and every `/api/*` call needs a per-launch
token. `cashu serve` prints a one-time address with it,
`Dashboard: http://127.0.0.1:<port>/#token=...`: open that one (the page keeps the
token for the tab and removes it from the address bar). A plain
`http://127.0.0.1:8500` without the token, or an `/api/...` URL opened directly in
the browser, answers 401, which is expected. The desktop app gets the token on its
own.

> Dev mode with hot-reload (to edit the dashboard): `cashu serve` plus, separately,
> `cd frontend && npm run dev` (Vite :5173, proxies to the API and adds the token
> from `<data dir>/api-token`, only for same-origin requests from the dev page:
> cross-site requests get a 403 from Vite, see `frontend/README.md`).

---

## Step 7b - Install the macOS app (optional)

If the user prefers a normal Mac app over the terminal, build `cashU.app`:

```bash
scripts/build_macos.sh            # -> build/macos/dist/cashU.app (+ a .zip)
```

It needs Node.js and the Xcode command line tools, takes a few minutes the first
time (npm and pip downloads) and never touches the dev setup (`frontend/node_modules`,
`.venv`). Then the **user** drags `build/macos/dist/cashU.app` to `/Applications`
and opens it; do not copy it there yourself. The app uses the same data dir and
database as the CLI, so everything from the steps above is already in it. Closing
the window quits the app.

- A build without a signature (the default; the script says "Signing skipped")
  opens fine on this Mac. On another Mac macOS blocks it: open it once, then
  System Settings > Privacy & Security > "Open Anyway". Signing and notarization
  need the user's own Apple Developer ID (`DEVELOPER_ID_APPLICATION`,
  `NOTARY_KEYCHAIN_PROFILE`, see README "Installing the macOS app"); never ask for
  Apple ID passwords or certificates in the chat.
- After the move to `/Applications`: Settings > Praca w tle installs the daily
  worker, and Settings > Agent AI shows the `claude mcp add` line, both pointing
  at `/Applications/cashU.app/Contents/MacOS/cashu`.
- Quick check without building: `pip install -e ".[desktop]"` and `cashu app`
  opens the same window from the checkout.

---

## Step 8 — Done. What next?

Tell the user they can now:
- **extend the dashboard** — adding a feature is described in [`AGENTS.md`](AGENTS.md),
- **add their bank** — a CSV parser per [`AGENTS.md`](AGENTS.md),
- **refresh data** - `cashu import-dir statements` (new CSV) or `cashu eb resync` (OB).

Finally, **check `git status`** — if anything under `data/` or `statements/` shows
up as ready to commit, **that's a bug**: stop and fix `.gitignore` before the user
pushes anything.
