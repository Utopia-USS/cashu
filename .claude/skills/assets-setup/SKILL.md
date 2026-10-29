---
name: assets-setup
description: >
  Use when the user wants their net worth to include a flat, house, plot, car or other non-bank asset,
  or asks how to add or revalue such an asset.
  Applicability - POSITIVE: assets module (Majątek) setup for one profile: which manually valued
  assets to add (property, car with a depreciation curve, other), CLI commands with placeholders,
  revaluing later, MCP check.
  Applicability - NEGATIVE: NOT loans or mortgages (loans-setup), bank accounts and cash
  (budget-setup) or brokerage accounts (investments-setup).
  Triggers: /assets-setup, "dodaj mieszkanie", "dodaj auto", "majątek", "skonfiguruj aktywa", "wycena
  nieruchomości", "utrata wartości auta", "wartość netto bez mieszkania".
---

# assets-setup: manually valued assets

A short guided setup (5-10 minutes). You explain what belongs here, prepare the commands, and the user
runs them. Conversation in Polish, files in English, regular hyphens only.

## Relationship to the workspace

| The workspace CLAUDE.md and MCP server own | This skill adds |
|---|---|
| privacy level, boundaries, the MCP tool list, where files go | what counts as a manually valued asset and which type it gets |
| which profile the workspace serves | the `add-position` / `set-vehicle` / `set-balance` commands with placeholders for the user |
| the `cashu` CLI name (packaged app or checkout) | the car depreciation mechanism and the revaluation rhythm |

## Problem -> reference mapping

| Task / question | Start with |
|---|---|
| First session in a new workspace | this file, Flow step 0 |
| Which profile, is MCP connected, privacy level | this file, Flow step 1 |
| Is this an asset, a loan, a bank account or a brokerage account | this file, Flow step 2 |
| Add a flat, house, plot or other asset | this file, Flow step 3 |
| Car value over time (depreciation curve) | this file, Flow step 3 |
| Revalue an asset later | this file, Flow step 4 |
| Does the asset show up in net worth | this file, Flow step 5 |

## Non-negotiable

Privacy and boundaries (say the first two lines at the start):

- Data reaches you only through the profile's MCP server `cashu-<slug>`, logged in Ustawienia > Agent
  AI. Read the privacy level from `profile_overview` (`strict` or `amounts`). **Ścisły (strict,
  default):** you see net worth bucket shares and percentages, no amounts, account numbers or names.
  **Z kwotami:** also amounts.
- The MCP server has no write tool for assets, so values are entered by the user: you prepare each
  command with placeholders (`<WARTOSC>`, `<CENA_ZAKUPU>`), the user fills them in and runs it in their
  own terminal (not with `!` here). In strict mode do not ask for the values; in amounts mode the user
  may tell you, but still runs the command.
- Never ask for addresses, land register (księga wieczysta) numbers, VINs, registration plates, IBANs
  or account numbers. A city and a size are enough if the user wants help estimating a value.
- Do not run `cashu accounts` or `cashu stats` (they print balances and names); the user runs them.
- Valuation facts that change (prices per m2, typical depreciation of a car model) are looked up online
  with a source, never from memory, and only if the user asks. You explain the mechanism; the value is
  the user's estimate. Never bypass bot protection on a price site.

## MCP tools used

`profile_overview` (privacy level, modules), `setup_status("assets")` (steps: position, vehicle
curve), `networth_breakdown` (bucket shares per currency, to confirm the asset appears).

## Flow

0. **Workspace layout (first session only).** If this workspace has no
   `notes/workspace-setup.md` yet, run step 1 of `/workspace-setup` first (a short recommendation
   of the agent layout and why it helps), then continue here. Skip it when the file exists or the
   user declines.
1. **Profile.** Use the connected `cashu-<slug>` server (ask which one if several; never mix
   profiles). In the profile's agent workspace (its `CLAUDE.md` names the profile) it is configured in
   `.mcp.json`. Elsewhere, if none is connected: the `claude mcp add` line from Ustawienia > Agent AI,
   then restart Claude Code (or create the workspace there and start Claude Code in it). `cashu` in
   the commands below is the CLI named in the workspace's `CLAUDE.md` (in the packaged app, the app's
   binary). Call `profile_overview` and `setup_status("assets")`; state the privacy level.
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
   cashu --profile <slug> add-position "Mieszkanie" --type property --value <WARTOSC> --currency PLN
   cashu --profile <slug> set-vehicle "Auto" <CENA_ZAKUPU> <DATA_ZAKUPU_YYYY-MM-DD> --rate 15 --floor <WARTOSC_MINIMALNA>
   ```

   Car curve mechanism: declining balance, the value drops by `--rate` percent of the remaining value
   each year and never below `--floor`. 15% is the default, not a recommendation; the user picks it.
4. **Revaluing later:** `cashu --profile <slug> set-balance <ID_KONTA> <NOWA_WARTOSC> --date
   <YYYY-MM-DD>` records a new valuation from that date (the account id is in `cashu accounts`, run by
   the user). Suggest a rhythm the user chooses (e.g. once a year for property).
5. **Check:** `setup_status("assets")` shows the steps done; `networth_breakdown` shows the property /
   vehicle bucket with its share. The Majątek tab and Przegląd in the dashboard show the values to the
   user (you do not take screenshots).
6. **Next:** a mortgage against the flat goes to `/loans-setup`, so net worth shows the asset and the
   liability side by side.

## References

None: this skill is single-file; the whole procedure is above.

## See also

- `/workspace-setup` - first session in a new workspace: the recommended agent layout (step 0).
- `/loans-setup` - a mortgage or loan against the asset, so net worth shows both sides.
- `/budget-setup` - bank accounts and cash.
- `/investments-setup` - brokerage accounts.

## Self-audit checklist

Before telling the user it is done:
1. The first two privacy lines were said and the privacy level from `profile_overview` was stated.
2. Every value went into a placeholder command the user ran themselves; in strict mode you did not
   ask for values.
3. No address, land register number, VIN, plate, IBAN or account number was asked for or written down.
4. Any market price or depreciation figure you quoted came from an online source you named.
5. `setup_status("assets")` shows the steps done and `networth_breakdown` shows the asset's bucket.
