# ONBOARDING.md - setup guide (the agent walks the user through it)

> **For the user:** open this project in Claude Code (or another agent) and say:
> *"Walk me through the setup following ONBOARDING.md."* The agent will run the
> steps with you. You can also do it by hand - the commands are below.
>
> **For the agent:** this is a script to run *together with the user*. Go step by
> step. After each step, show the result and wait until it works before moving on.
> Ask questions at the points marked 🔀. Follow the data-safety rules in
> [`CLAUDE.md`](CLAUDE.md) - **never commit the user's data, never ask for bank
> passwords, API keys or the profile's recovery phrase**.

---

## Step 0 - Prerequisites

cashU is a native macOS app (macOS 13 or later). Check that the user has:
- **macOS 13+** (`sw_vers -productVersion`),
- (optional) **Ollama** - if they want to categorize spending with a local, offline LLM,
- only to build from source instead of downloading: the **Xcode command line tools**
  (`xcode-select -p`; else `xcode-select --install`), **Node.js 24** (`node --version`) and **pnpm**
  through corepack (`corepack enable`).

If something is missing, say how to install it (macOS: `brew install node ollama`) and wait.

> 🔀 **Already using the Python cashU app?** The native app does not import the old data. On its
> first start it shows the old-data screen: the user copies its prompt to you, chooses "Continue
> without the old data" and creates the profile; then follow the import-builder skill, section "Old
> cashU (Python) data", and continue at step 3 for anything new.

---

## Step 1 - Get and install the app

**Download (recommended):** the dmg for this Mac from the latest release,
https://github.com/Utopia-USS/cashu/releases/latest - `cashU-<version>-mac-arm64.dmg` on Apple silicon
(`uname -m` prints `arm64`), `cashU-<version>-mac-x64.dmg` on Intel. The **user** downloads it, opens it
and drags cashU to Applications; do not copy it there yourself. Releases are signed and notarized and
update themselves (Settings > Updates).

**Or build from source** (this checkout):

```bash
corepack enable && pnpm install --frozen-lockfile
node apps/desktop/scripts/package-macos.mjs arm64    # x64 on an Intel Mac
```

The first build takes a few minutes. The result is
`build/t46/electron-builder/mac-arm64/cashU.app` (`mac/` for x64). The **user** drags it to
`/Applications` and opens it. A build from source is signed ad hoc and does not update itself: it
opens on this Mac; on another Mac macOS blocks it until the user confirms it in System Settings >
Privacy & Security > "Open Anyway".

✅ **Verify:** the app opens with the profile wizard.

---

## Step 2 - Create the profile 🔀

> 🔀 **One person or several?** Data is kept per **profile** (a person or a household), and each
> profile is its own encrypted vault. Create one profile per person (or one for the household).

In the wizard the user picks a name, the modules (budget, assets, loans, investments) and the base
currency. The app then shows a **24-word recovery phrase**: the user writes it down somewhere safe
outside the computer. It is the only way back into the profile on a new machine. **Never ask for it,
never let them paste it into the chat.**

The wizard then offers an **agent workspace** (a folder under `~/Documents/cashU` with the profile's
MCP server, the setup skills and permissions). Recommend it: the next steps (and the `/budget-setup`,
`/investments-setup`, ... skills) work best from there.

Set up the `cashu` command for the terminal (the app writes the launcher at every start):

```bash
alias cashu="$HOME/Library/Application Support/cashU/bin/cashu"
cashu --help
cashu profiles list            # the slug of each profile, for --profile <slug>
```

✅ **Verify:** `cashu profiles list` shows the new profile. More profiles: the wizard again (profile
menu > New profile), or `cashu profiles add "<name>" --modules budget`.

---

## Step 3 - Load data 🔀

Ask the user **where the data comes from**. Two paths (you can do both):

### 3A. CSV import (recommended first - works right away, no API)

The user exports history from their online banking to CSV and arranges the files under
`statements/<bank>/` in this checkout (the directory is git-ignored - data stays local) or in the
workspace's `inbox/`:

```
statements/mbank/*.csv    statements/erste/*.csv    statements/pekao/*.csv
```

Supported formats (verified): **mBank** (cp1250, `;`, multi-currency),
**Erste/Santander** (UTF-8, no header, positional), **Pekao** (UTF-8, `;`).

> 🔀 **A different bank?** If the user has a bank outside these three, the way is a **connector**
> that the owner approves once in the app (Ustawienia > Konektory) and the app then runs itself: the
> `/import-builder` skill writes it, the contract is [`docs/connectors.md`](docs/connectors.md). Ask
> once whether the user hands you the statement with values or wants the blind route (you see only its
> masked structure).

```bash
cashu --profile <slug> import-dir statements     # bank from the subdir name, idempotent
cashu --profile <slug> match-transfers           # pair internal transfers (by IBAN)
cashu --profile <slug> stats                     # sanity check: net worth per currency + cashflow
```

### 3B. Open Banking (live sync) - see step 4

If the user only wants CSV, skip step 4 and go to step 5.

✅ **Verify:** `cashu --profile <slug> accounts` shows the accounts and `stats` a sensible net worth.
If net worth looks doubled - check whether the same account got imported twice (CSV gives a bare NRB,
OB the full IBAN). Flag it to the user if something is off.

---

## Step 4 - Open Banking (optional, live sync) 🔀

Skip if CSV import is enough for the user. This needs a free **Enable Banking** account ("Restricted
Production" tier). Everything happens in the app; some steps **the user does themselves** - you have
no access to their bank panel or their keys:

1. The user creates an application at <https://enablebanking.com/cp/>, generates an RSA key pair,
   uploads the public key, and keeps the **private** key file on their Mac (outside this repository).
2. In the EB panel they whitelist the redirect **`https://127.0.0.1:18888/eb/callback`** and click
   "Activate by linking accounts".
3. In the app: Settings > Konektory (Connectors) > Open Banking > "Configure Enable Banking": the
   application ID and the private key file (the key is read locally), then "Check application".
4. "Load banks", pick the bank, "Connect bank": the bank's page opens in the browser, the user logs in
   and approves (**they enter the password/SCA**), then pastes the full callback URL from the browser
   back into the app and completes the connection.
5. Later syncs: the daily background job, or "Sync now" in the same panel
   (`cashu --profile <slug> eb resync` from the terminal). Sessions are valid ~90 days, then the user
   connects again. `cashu --profile <slug> eb sessions` lists them.

> ⚠️ **Rate limits:** banks throttle PSD2 hard (`429`). Sync **~once a day**, not in a loop. Sync is
> resilient - one account's error doesn't stop the rest.

---

## Step 5 - Categorize spending 🔀

The PL rules (~420) always run and fire automatically after import. Ask whether the user wants to add
an LLM for unknown merchants:

```bash
cashu --profile <slug> categorize          # deterministic rules only (always safe)
cashu --profile <slug> categorize --llm    # + LLM for the tail of unknown merchants
```

> 🔀 **Which LLM backend?** (app: Settings > Sekrety (Secrets) > categorization)
> - **Ollama (default, offline)** - nothing leaves the machine. Requires `ollama serve` +
>   `ollama pull qwen2.5:3b` (or `:7b` for better coverage).
> - **Anthropic (cloud)** - the user switches it on in that panel, reads and accepts the consent text
>   and types the Anthropic API key into the app themselves (you never see it). Sends **only
>   merchant names**, never IBANs, balances, or names. Confirm with the user that they accept sending
>   merchant names to the cloud before they enable it.

Corrections teach the system: `cashu --profile <slug> set-category <merchant> <category>` creates a
durable rule; changing a single transaction's category in the app survives re-categorization.

---

## Step 6 - Manual positions (optional)

Non-bank assets/liabilities (home, mortgage, car, cash) are added with commands (the `/assets-setup`
and `/loans-setup` skills walk through them). Offer them if the user wants a full picture of their net
worth:

```bash
cashu --profile <slug> add-position "Mieszkanie" --type property --value 730000
cashu --profile <slug> loans add "Kredyt hipoteczny" --type mortgage --principal 680000 --rate 6.27 \
    --years 30 --start 2026-08-01
cashu --profile <slug> loans add "Kredyt samochodowy" --principal 60000 --rate 8.9 --months 72 --start 2025-03-01
cashu --profile <slug> loans list                                   # the GID of each loan
cashu --profile <slug> loans set-payment <LOAN_GID> --text "RATA KREDYTU"   # recognise its installments
cashu --profile <slug> loans set-balance <LOAN_GID> 652000 --date 2026-09-30  # a figure from a statement
cashu --profile <slug> set-vehicle "Auto" 62500 2025-06-16 --rate 15 --floor 8000
cashu --profile <slug> cash-add 200 "zakupy" groceries                # a cash expense
```

(The values above are just format examples - the user enters their own.)

---

## Step 7 - Tour the app

Walk the user through the app: the overview (net worth per currency and its chart), the budget page
(where the money goes, cashflow, subscriptions, month close), loans, investments, and Settings
(profile, modules, AI agent (MCP), connectors and Open Banking, background work, secrets, app
language). If you have the browser or screenshot tools, ask the user for a screenshot rather than
opening their real data yourself.

> 🔀 **Background work?** Settings > Praca w tle (Background work) keeps the cashU service running
> after the window closes, so the daily jobs (bank sync, investments rules, notifications) run at 07:30
> without the app open.

---

## Step 8 - Done. What next?

Tell the user they can now:
- **work with their agent** - open the profile's workspace in Claude Code and run `/budget-setup`,
  `/investments-setup`, `/assets-setup`, `/loans-setup` ([`docs/agents/skills.md`](docs/agents/skills.md)),
- **add their bank or broker** - a connector with `/import-builder`
  ([`docs/connectors.md`](docs/connectors.md)),
- **refresh data** - `cashu --profile <slug> import-dir statements` (new CSV) or the daily Open
  Banking sync.

Finally, **check `git status`** - if anything under `data/` or `statements/` shows up as ready to
commit, **that's a bug**: stop and fix `.gitignore` before the user pushes anything.
