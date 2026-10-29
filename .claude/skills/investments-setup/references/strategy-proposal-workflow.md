# Strategy proposal workflow (phase 7 and the end of phase 8)

What this is: the steps that turn the interview into a strategy proposal the owner approves in the
app, and how the interview is closed as the first recorded review.

## Phase 7: writing the strategy through the app

1. Draft `strategy.md` (Polish prose) and `strategy.yaml` (schema v1) with `references/schema-mapping.md`
   and the template reference `references/strategy-schema.md` (examples: `references/templates/passive_etf.yaml`,
   `references/templates/blank.yaml`; custom rules: `references/expressions.md`). The `strategy.md`
   section list is in `references/phases.md` (Phase 7).
2. Consistency: targets sum to 1; every YAML rule is referenced in `strategy.md`; every failure mode
   has a safeguard; anything not expressible goes to the `strategy.md` section of manual checks in the
   weekly review ("ręcznie, do czasu wsparcia w aplikacji").
3. Read the strategy back in 10 lines, list every value you defaulted without asking (horizon,
   deposit day, where cash is kept, placeholder amounts in strict mode), and ask for approval.
4. Call `propose_strategy(yaml, md, reason)`. `reason` is the changelog entry: version, what, why, and
   **market context** looked up online with sources (benchmark level vs its 1-year high, 12-month
   change, FX, inflation). If the tool reports validation errors, fix them (line and column are given)
   and propose again; only expected warnings may remain, and you name them.
5. Tell the user where to approve: Inwestycje > the strategy pill (`Strategia v{n}`) > the pending proposal > `Zobacz` >
   `Zatwierdź jako v{n}`. After approval `strategy_status` shows the new version.

Never write `strategy.yaml` / `strategy.md` in the data dir yourself and never run `cashu invest
strategy init` on the user's behalf: the proposal is the only path, so the owner sees the diff.

## Phase 8 end: the interview counts as the first review

After the strategy is approved: record theses the user dictated for the largest positions with
`upsert_thesis` (entry type `sentiment_correction` | `trend` | `special_situation`, thesis,
invalidation, exit plan, size plan, all in the user's words), then `mark_review_done(notes)` with the
start-up checklist (accounts to open, transfers to set up, theses still to write, deadlines). Notes are
shown in the app, so write them in Polish.

Reminders: the app's worker sends notifications per the strategy's `notifications` and opens the weekly
review on the digest weekday. One-off deadline reminders (wrapper deadline, a claim filing date) can be
offered as scheduled tasks; creating them needs the user's explicit yes.
