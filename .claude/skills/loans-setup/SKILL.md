---
name: loans-setup
description: >
  Use when the user wants to track a mortgage, car loan or cash loan, see the amortization schedule and
  outstanding debt, or stop installments being counted as subscriptions.
  Applicability - POSITIVE: loans module (Kredyty) setup for one profile: each loan's terms, recognising
  installments by a title phrase, recording the balance the bank reports, MCP check.
  Applicability - NEGATIVE: NOT manually valued assets such as the property or car (assets-setup) or bank imports and spending
  categories (budget-setup).
  Triggers: /loans-setup, "dodaj kredyt", "hipoteka", "kredyt samochodowy", "harmonogram spłat", "ile
  zostało do spłaty", "raty jako subskrypcje", "skonfiguruj kredyty".
---

# loans-setup: mortgages and loans

A short guided setup (5-10 minutes per loan). You explain what is needed, prepare the commands, and the
user runs them. Conversation in Polish, files in English, regular hyphens only.

## Relationship to the workspace

| The workspace CLAUDE.md and MCP server own | This skill adds |
|---|---|
| privacy level, boundaries, the MCP tool list, where files go | which loan terms are needed and where the user finds them |
| which profile the workspace serves | the `loans add` / `set-payment` / `set-balance` commands with placeholders for the user |
| the `cashu` CLI name (packaged app or checkout) | installment recognition by a title phrase, so installments leave Subskrypcje |

## Problem -> reference mapping

| Task / question | Start with |
|---|---|
| First session in a new workspace | this file, Flow step 0 |
| Which profile, is MCP connected, privacy level | this file, Flow step 1 |
| Which terms the user needs, mortgage vs other loan, a variable rate changed | this file, Flow step 2 |
| Add a loan | this file, Flow step 3 |
| Installments counted as subscriptions | this file, Flow step 4 |
| Schedule and bank balance differ (overpayment) | this file, Flow step 5 |
| Does the loan look right | this file, Flow step 6 |

## Non-negotiable

Privacy and boundaries (say the first two lines at the start):

- Data reaches you only through the profile's MCP server `cashu-<slug>`, logged in Ustawienia > Agent
  AI. Read the privacy level from `profile_overview` (`strict` or `amounts`). **Ścisły (strict,
  default):** `loans_summary` gives rates, remaining months and installments as a share of income; no
  amounts, account numbers or names. **Z kwotami:** also amounts.
- The MCP server has no write tool for loans, so terms are entered by the user: you prepare each
  command with placeholders (`<KWOTA>`, `<OPROCENTOWANIE>`), the user fills them in and runs it in their
  own terminal (not with `!` here). In strict mode do not ask for amounts; the rate and the term are
  fine to discuss. In amounts mode the user may tell you, but still runs the command.
- Never ask for the loan agreement number, the lender's account number or any IBAN. Installments are
  recognised by a phrase from the transfer title (`--text`); the `--iban` option exists, but the user
  fills it in themselves without telling you.
- Do not run `cashu loans list`, `cashu accounts` or `cashu stats` (they print amounts and names).
- Facts that change (reference rates WIBOR / WIRON, a bank's current margin offer) are looked up online
  with a source, never from memory. No advice on refinancing or overpaying: explain the mechanism and
  show the user's own numbers, the decision is theirs. Never bypass bot protection.

## MCP tools used

`profile_overview`, `setup_status("loans")` (steps: loan added, installments recognised),
`loans_summary` (per loan: rate, remaining months, share of income when the budget module is on),
`recurring_payments` (budget on: confirm installments are no longer listed as subscriptions).

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
   binary). Call `profile_overview` and `setup_status("loans")`; state the privacy level.
2. **What loans** (one at a time): mortgage (`--type mortgage`) or another loan (`--type loan`: car,
   cash, instalment). A profile can have any number of loans. For each the user needs, from the
   agreement or the bank's app: amount borrowed, annual rate in percent (for a variable rate: today's
   rate; when it changes, the user updates it by running the same `loans add` with the same name), term
   in years or months, first installment date, optionally the disbursement date.
3. **Commands** for the user (add `--profile <slug>` when the profile is not the default one):

   ```bash
   cashu --profile <slug> loans add "Hipoteka" --type mortgage --principal <KWOTA> --rate <OPROCENTOWANIE> \
       --years <LATA> --start <PIERWSZA_RATA_YYYY-MM-DD> --origination <WYPLATA_YYYY-MM-DD>
   cashu --profile <slug> loans add "Kredyt samochodowy" --principal <KWOTA> --rate <OPROCENTOWANIE> \
       --months <MIESIACE> --start <PIERWSZA_RATA_YYYY-MM-DD>
   ```

   The output shows the loan id; the user keeps it for the next steps.
4. **Recognising installments** (budget module on): ask the user to look at one installment transfer
   in the bank and tell you only a generic phrase from its title (e.g. "RATA KREDYTU"), nothing with
   numbers. Built-in phrases already catch many banks; then:

   ```bash
   cashu --profile <slug> loans set-payment <ID_KREDYTU> --text "RATA KREDYTU"
   cashu --profile <slug> categorize
   ```

   Installments then land in "Raty kredytów", never in Subskrypcje. You may run `categorize` yourself
   (it prints counts only).
5. **Balance from the bank** (optional, when the schedule and the bank differ, e.g. after an
   overpayment): `cashu --profile <slug> loans set-balance <ID_KREDYTU> <KWOTA_DO_SPLATY> --date
   <YYYY-MM-DD>`. It wins over the schedule from that date, reduced by the principal repaid after it.
6. **Check:** `setup_status("loans")` steps done; `loans_summary` shows the rate and remaining months as
   expected (ask the user to confirm against the bank's app); `recurring_payments` no longer lists the
   installment as a subscription. The Kredyty tab shows the schedule and the balance over time.
7. **Next:** the property itself goes to `/assets-setup`, so net worth shows both sides.

## References

None: this skill is single-file; the whole procedure is above.

## See also

- `/workspace-setup` - first session in a new workspace: the recommended agent layout (step 0).
- `/assets-setup` - the property or car the loan paid for, so net worth shows both sides.
- `/budget-setup` - bank imports and spending categories (installments land in "Raty kredytów").

## Self-audit checklist

Before telling the user it is done:
1. The first two privacy lines were said and the privacy level from `profile_overview` was stated.
2. Every term went into a placeholder command the user ran themselves; in strict mode you did not ask
   for amounts.
3. No agreement number, lender account number or IBAN was asked for; the title phrase has no numbers.
4. Any reference rate or margin you quoted came from an online source you named; no refinancing or
   overpaying advice was given.
5. `setup_status("loans")` shows the steps done, `loans_summary` matches the bank's app per the user,
   and `recurring_payments` no longer lists the installment (budget module on).
