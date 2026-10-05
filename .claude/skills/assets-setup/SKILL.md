---
name: assets-setup
description: Short guided setup of the finanse assets module (Majątek) for one profile - which manually valued assets to add (home, plot, car with a depreciation curve, other assets), the exact CLI commands with placeholders for the user to run, how to revalue them later, and a check through the profile's finanse MCP server. Use when the user wants their net worth to include a flat, house, plot, car or other non-bank asset, or asks how to add or revalue such an asset. Triggers on /assets-setup and on Polish requests such as "dodaj mieszkanie", "dodaj auto", "majątek", "skonfiguruj aktywa", "wycena nieruchomości", "utrata wartości auta", "wartość netto bez mieszkania". Not for loans or mortgages (loans-setup), bank accounts (budget-setup) or brokerage accounts (investments-setup).
---

# assets-setup: manually valued assets

A short guided setup (5-10 minutes). You explain what belongs here, prepare the commands, and the user
runs them. Conversation in Polish, files in English, regular hyphens only.

## Privacy and boundaries (say the first two lines at the start)

- Data reaches you only through the profile's MCP server `finanse-<slug>`, logged in Ustawienia > Agent
  AI. Read the privacy level from `profile_overview` (`strict` or `amounts`). **Ścisły (strict, default):** you see net worth
  bucket shares and percentages, no amounts, account numbers or names. **Z kwotami:** also amounts.
- The MCP server has no write tool for assets, so values are entered by the user: you prepare each
  command with placeholders (`<WARTOSC>`, `<CENA_ZAKUPU>`), the user fills them in and runs it in their
  own terminal (not with `!` here). In strict mode do not ask for the values; in amounts mode the user
  may tell you, but still runs the command.
- Never ask for addresses, land register (księga wieczysta) numbers, VINs, registration plates, IBANs
  or account numbers. A city and a size are enough if the user wants help estimating a value.
- Do not run `finanse accounts` or `finanse stats` (they print balances and names); the user runs them.
- Valuation facts that change (prices per m2, typical depreciation of a car model) are looked up online
  with a source, never from memory, and only if the user asks. You explain the mechanism; the value is
  the user's estimate. Never bypass bot protection on a price site.

## MCP tools used

`profile_overview` (privacy level, modules), `setup_status("assets")` (steps: position, vehicle
curve), `networth_breakdown` (bucket shares per currency, to confirm the asset appears).

## Flow

1. **Profile.** Use the connected `finanse-<slug>` server (ask which one if several; never mix
   profiles). In the profile's agent workspace (its `CLAUDE.md` names the profile) it is configured in
   `.mcp.json`. Elsewhere, if none is connected: the `claude mcp add` line from Ustawienia > Agent AI,
   then restart Claude Code (or create the workspace there and start Claude Code in it). `finanse` in
   the commands below is the CLI named in the workspace's `CLAUDE.md` (in the packaged app, the app's
   binary). Call `profile_overview` and `setup_status("assets")`; state the privacy
   level.
2. **What to add** (one question at a time, question tool with options):
   - real estate: flat, house, plot (type `property`, illiquid: counts toward net worth, not toward
     liquid money);
   - car or another asset that loses value (type `vehicle`, with a depreciation curve);
   - other manually valued assets (type `other`; `investment` for a manually valued investment that is
     not a brokerage account);
   - not here: mortgages and loans (`/loans-setup`), bank accounts and cash (`/budget-setup`),
     brokerage accounts (`/investments-setup`).
3. **Commands** for the user (add `--profile <slug>` when the profile is not the default one; names
   are free text, keep them generic like "Mieszkanie", "Auto"):

   ```bash
   finanse --profile <slug> add-position "Mieszkanie" --type property --value <WARTOSC> --currency PLN
   finanse --profile <slug> set-vehicle "Auto" <CENA_ZAKUPU> <DATA_ZAKUPU_YYYY-MM-DD> --rate 15 --floor <WARTOSC_MINIMALNA>
   ```

   Car curve mechanism: declining balance, the value drops by `--rate` percent of the remaining value
   each year and never below `--floor`. 15% is the default, not a recommendation; the user picks it.
4. **Revaluing later:** `finanse --profile <slug> set-balance <ID_KONTA> <NOWA_WARTOSC> --date
   <YYYY-MM-DD>` records a new valuation from that date (the account id is in `finanse accounts`, run by
   the user). Suggest a rhythm the user chooses (e.g. once a year for property).
5. **Check:** `setup_status("assets")` shows the steps done; `networth_breakdown` shows the property /
   vehicle bucket with its share. The Majątek tab and Przegląd in the dashboard show the values to the
   user (you do not take screenshots).
6. **Next:** a mortgage against the flat goes to `/loans-setup`, so net worth shows the asset and the
   liability side by side.
