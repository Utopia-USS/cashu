---
name: loans-setup
description: Short guided setup of the cashU loans module (Kredyty) for one profile - adding each mortgage or loan with its terms (principal, rate, term, first installment date), teaching the budget to recognise the installments by a title phrase, recording the outstanding balance the bank reports, and a check through the profile's cashU MCP server. Use when the user wants to track a mortgage, car loan or cash loan, see the amortization schedule and outstanding debt, or stop installments being counted as subscriptions. Triggers on /loans-setup and on Polish requests such as "dodaj kredyt", "hipoteka", "kredyt samochodowy", "harmonogram spłat", "ile zostało do spłaty", "raty jako subskrypcje", "skonfiguruj kredyty". Not for assets (assets-setup) or bank imports (budget-setup).
---

# loans-setup: mortgages and loans

A short guided setup (5-10 minutes per loan). You explain what is needed, prepare the commands, and the
user runs them. Conversation in Polish, files in English, regular hyphens only.

## Privacy and boundaries (say the first two lines at the start)

- Data reaches you only through the profile's MCP server `cashu-<slug>`, logged in Ustawienia > Agent
  AI. Read the privacy level from `profile_overview` (`strict` or `amounts`). **Ścisły (strict, default):** `loans_summary`
  gives rates, remaining months and installments as a share of income; no amounts, account numbers or
  names. **Z kwotami:** also amounts.
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

1. **Profile.** Use the connected `cashu-<slug>` server (ask which one if several; never mix
   profiles). In the profile's agent workspace (its `CLAUDE.md` names the profile) it is configured in
   `.mcp.json`. Elsewhere, if none is connected: the `claude mcp add` line from Ustawienia > Agent AI,
   then restart Claude Code (or create the workspace there and start Claude Code in it). `cashu` in
   the commands below is the CLI named in the workspace's `CLAUDE.md` (in the packaged app, the app's
   binary). Call `profile_overview` and `setup_status("loans")`; state the privacy
   level.
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
