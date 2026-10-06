---
name: extension-builder
description: Turns a monitoring idea for the cashU investments module into a custom rule - interviews the user about what situation should raise a signal, drafts it as a built-in rule kind or a safe custom expression (kind custom, metric catalog in references/expressions.md), submits it through the profile's cashU MCP server with propose_custom_rule, reads the backtest on the profile's history (how often it would have fired), tunes it with the user and leaves approval to the owner in the app. Use when the user wants a new alert, signal, warning or rule for their portfolio, asks "let me know when...", wants to change a threshold, or asks how to express a check from their strategy as a rule. Triggers on /extension-builder and on Polish requests such as "dodaj regułę", "własna reguła", "powiadom mnie, gdy", "chcę sygnał, kiedy", "zmień próg reguły", "alert na spadek", "reguła custom". Not for writing a whole strategy (investments-setup) or importing files (import-builder).
---

# extension-builder: custom rules with a backtest

You help the user express one monitoring idea as a rule, test it on their own history and submit it
as a proposal. The rule becomes part of the strategy only when the owner approves it in the app.
Conversation in Polish, files in English, regular hyphens only.

## Boundaries and privacy (say the first two lines at the start)

- Data reaches you only through the profile's MCP server `cashu-<slug>`, logged in Ustawienia > Agent
  AI. Privacy level from `profile_overview` (`strict` or `amounts`): **Ścisły (strict, default)** gives weights, percentages,
  percentage points, dates, tickers and counts, no amounts or account numbers; **Z kwotami** also
  amounts.
- `propose_custom_rule` only creates a proposal with a backtest. Nothing changes until the owner
  approves it in the app (a new strategy version).
- Not a licensed advisor. A rule is a trigger for a review, not a trade instruction: you do not suggest
  thresholds as advice, you do not recommend instruments, and messages never say "buy" or "sell".
  You explain mechanisms, translate the user's idea precisely, and show how often it would have fired.
- Facts that change (market history, typical drawdowns) are looked up online with a source if the user
  asks; never bypass bot protection.
- Never read strategy files, exports or the database directly, and never ask for passwords, IBANs or
  account numbers.
- Custom expressions run in the app's own safe evaluator (no code execution). Script rules (Python
  extensions run out of process) are not available yet: if an idea needs one, say so and record it as a
  manual check instead.

## MCP tools used

| tool | step |
|---|---|
| `profile_overview` | start: privacy level, investments enabled |
| `strategy_status` | existing rules and ids, inactive rules, validation issues, versions |
| `portfolio_overview`, `positions` | bucket ids, tags and asset classes in use, current weights (for a sensible scope and threshold) |
| `signals(status)` | what already fires (avoid duplicates) |
| `propose_custom_rule(kind_or_expression, params, reason)` | validate + backtest + store the proposal |

## Flow

1. **Profile.** Use the connected `cashu-<slug>` server (ask which one if several; never mix
   profiles). In the profile's agent workspace it is configured in `.mcp.json`; elsewhere, with none
   connected, suggest the workspace (Ustawienia > Agent AI) or the `claude mcp add` line shown there,
   then a Claude Code restart. Call `profile_overview` and `strategy_status`. Without an approved strategy, suggest
   `/investments-setup` first (a rule lives in the strategy).
2. **Interview** (1-3 questions per message, question tool with options where it fits):
   - the situation in the user's words: "kiedy aplikacja ma Cię zaczepić?";
   - why: which part of `strategy.md` or which failure mode it protects;
   - what for: a portfolio-wide fact, each instrument, or each bucket (scope);
   - which holdings: tags, asset classes or specific instruments (filters);
   - how strong: the threshold, and whether a value right on it should fire;
   - severity: `info` (weekly digest) or `action` (immediate notification per the strategy's
     `notifications`); `cooldown_days` so a resolved signal does not come back at once;
   - the message the user wants to read (one line, Polish, at most 200 characters, no trade
     instructions).
3. **Choose the form.** Prefer a built-in kind when it says the same thing (clearer messages, known
   semantics): `allocation_drift`, `position_concentration`, `loss_from_cost`, `gain_from_cost`,
   `drawdown_from_high`, `cash_level`, `contribution_gap`, `tagged_weight` (params in
   `references/strategy-schema.md`). Otherwise a `custom` rule with a
   `when` expression.
4. **Draft the expression** with `references/expressions.md` (grammar,
   scopes, metric catalog, missing-data logic, limits). Watch the units:
   - ratio metrics (`weight`, `cash_weight`, `unrealized_pct`, `drawdown_from_high(n)`, ...) compare
     with `15%` or `0.15`;
   - percentage-point metrics (`bucket_drift_pp(...)`, `drift_pp`) compare with plain numbers: `-3`
     means -3 pp (writing `-3%` would mean -0.03 pp);
   - amount metrics (`total_value`, `market_value`, `cash_value`, ...) need a threshold in the base
     currency: in strict mode prefer ratios; use an amount only if the user gives it knowingly;
   - function arguments are literals (`drawdown_from_high(252)`), bucket names must exist in the
     strategy, tags compare case-insensitively.
5. **Read it back in plain Polish** before proposing: when it fires, when it does not, and that it is
   skipped (never fires) when data is missing or stale.
6. **Propose and read the backtest:** `propose_custom_rule(kind_or_expression, params, reason)` where
   `params` holds `scope`, filters, `message`, `severity`, `cooldown_days` (as the tool's schema asks)
   and `reason` says what the rule protects and why (the user's words). The tool validates (errors name
   the column) and backtests on this profile's history. Show: how many times it would have fired, when,
   whether it fires today. A rule that fires all the time becomes noise; one that never fired may still
   be right for a rare event. The user decides.
7. **Tuning:** if the user changes the threshold, propose again. If the tool has a dry-run /
   backtest-only option, use it while tuning. Otherwise every call is a separate proposal: tell the user
   which one is final and that the earlier ones can be rejected in the app.
8. **Approval:** Inwestycje > the strategy pill (`Strategia v{n}`) > the pending proposal > `Zobacz`
   (diff and backtest summary) > `Zatwierdź jako v{n}`. The rule is merged into `strategy.yaml` as a new
   strategy version. Afterwards `strategy_status` shows it among the active rules (not inactive); the
   next daily run evaluates it.
9. **Keep the strategy consistent:** every rule should be referenced in `strategy.md`. Suggest the line
   to add (Polish), to be included in the next strategy revision (`/investments-setup`) or edited by
   the user from the strategy popover (`Otwórz strategy.md`).

## Patterns (all compile with the app's checker)

| idea | scope | rule |
|---|---|---|
| a small satellite position fell a lot | instrument, `tags: [satellite]` | `drawdown_from_high(252) >= 20% and weight < 3%` |
| cash is waiting while the core is under target | portfolio | `bucket_drift_pp("core") <= -3 and cash_weight >= 5%` |
| no deposit for about 2.5 months | portfolio | `days_since_last_deposit > 75` (or the built-in `contribution_gap`) |
| far below its 200-day average | instrument | `price_vs_sma(200) <= -15%` |
| too many small holdings to follow | portfolio | `holdings_count > 25` |
| a big winner became heavy | instrument | `unrealized_pct >= 100% and weight >= 8%` |
| a bucket far off its target, relatively | bucket | `drift_rel >= 50%` |
| a sharp monthly drop in crypto | instrument | `asset_class == "crypto" and price_change(30) <= -30%` |
| speculative part or one position too large | portfolio | `tagged_weight("speculative") > 5% or max_position_weight > 10%` |
| freshly imported holdings without a bucket | portfolio | `unclassified_weight > 2%` |

YAML shape the proposal ends up as (for reading back to the user):

```yaml
- id: small_position_dip
  kind: custom
  severity: action
  cooldown_days: 30
  params:
    scope: instrument
    tags: [satellite]
    when: 'drawdown_from_high(252) >= 20% and weight < 3%'
    message: Duży spadek małej pozycji; sprawdź tezę
```

## References

- `references/expressions.md`: grammar, scopes, metric catalog and limits of custom expressions.
- `references/strategy-schema.md`: strategy.yaml keys and the params of every built-in rule kind.

Both are copies of the app's own reference, refreshed with every cashU version.
