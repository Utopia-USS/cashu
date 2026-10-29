# Check-in workflow (weekly / monthly / quarterly review)

What this is: the step-by-step review of signals against an approved strategy, ending in a recorded
review.

Needs an approved strategy (`strategy_status`). If no strategy exists yet, a check-in is impossible:
say so and go to the interview.

1. `portfolio_overview`: if data is stale (freshness, last run), say so first and ask the user to run
   the rules in the app (`Uruchom reguły`) or `cashu invest run` in their terminal, then re-read.
2. `signals` for the open statuses (`active` and `acknowledged`, or `open` if the tool accepts it).
   Show only what exceeds thresholds, strongest first: rule, scope, measured vs threshold, severity,
   age. No signals is a good result; say so.
3. For each signal ask what the user does about it and why. Never suggest the action. For a position
   with a thesis, show its invalidation condition (`theses(instrument)`). Record with
   `record_decision(signal_id, action, reason)`: action `bought` | `sold` | `held` | `ignored` | `other`,
   reason in the user's words.
4. Walk the manual checks listed in `strategy.md` (things the schema cannot express yet).
5. Collect strategy change ideas; do not change the strategy mid-review. Changes follow the change
   rules in `strategy.md` (for example decided at the quarterly review), then go through
   `propose_strategy` with a changelog `reason` (see `references/strategy-proposal-workflow.md`).
6. `mark_review_done(notes)`: a short Polish summary (signals seen, decisions, open questions, next
   review). The review counts only when recorded.
