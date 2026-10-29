---
name: extension-builder
description: >
  Use when the user wants a new alert, signal, warning or rule for their portfolio, asks "let me know when...", wants to change a threshold, or asks how to express a check from their strategy as a rule.
  Applicability - POSITIVE: one monitoring idea turned into a built-in rule kind or a safe custom expression, proposed with propose_custom_rule, backtested on the profile's history and tuned with the user.
  Applicability - NEGATIVE: NOT for writing a whole strategy (/investments-setup), importing files (/import-builder) or alert proposals after a research run (/market-research).
  Triggers: /extension-builder, "dodaj regułę", "własna reguła", "powiadom mnie, gdy", "chcę sygnał, kiedy", "zmień próg reguły", "alert na spadek", "reguła custom".
---

# extension-builder: custom rules with a backtest

You help the user express one monitoring idea for the cashU investments module as a rule: interview
the user about what situation should raise a signal, draft it as a built-in rule kind or a safe custom
expression (kind custom, metric catalog in `references/expressions.md`), submit it through the
profile's cashU MCP server with `propose_custom_rule`, read the backtest on the profile's history (how
often it would have fired), tune it with the user and leave approval to the owner in the app. The rule
becomes part of the strategy only when the owner approves it in the app. Conversation in Polish, files
in English, regular hyphens only.

## Relationship to the workspace

| The workspace CLAUDE.md and MCP server own | This skill adds |
|---|---|
| privacy level, boundaries, the MCP tool list, where files go | the interview that turns an idea into scope, filters, threshold, severity and message |
| the profile's cashU server, `propose_custom_rule` validation and backtest | the choice between a built-in kind and a `custom` expression, units, patterns |
| strategy versions and approval in the app | reading the backtest back, tuning, keeping `strategy.md` consistent |

## Problem -> reference mapping

| Task / question | Start with |
|---|---|
| The user wants to be warned about a situation | this file, Flow |
| Is there a built-in kind for this, what are its params | [`references/strategy-schema.md`](references/strategy-schema.md) |
| Grammar, scopes, metric catalog, missing data, limits of a `custom` expression | [`references/expressions.md`](references/expressions.md) |
| A typical idea and the rule that expresses it, the YAML shape to read back | [`references/rule-patterns.md`](references/rule-patterns.md) |
| Percent vs percentage points vs amounts | this file, Flow step 4 |
| Where the owner approves the proposal | this file, Flow step 8 |

## Non-negotiable

### Boundaries and privacy (say the first two lines at the start)

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

### MCP tools used

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
   scopes, metric catalog, missing-data logic, limits) and the patterns in
   `references/rule-patterns.md`. Watch the units:
   - ratio metrics (`weight`, `cash_weight`, `unrealized_pct`, `drawdown_from_high(n)`, ...) compare
     with `15%` or `0.15`;
   - percentage-point metrics (`bucket_drift_pp(...)`, `drift_pp`) compare with plain numbers: `-3`
     means -3 pp (writing `-3%` would mean -0.03 pp);
   - amount metrics (`total_value`, `market_value`, `cash_value`, ...) need a threshold in the base
     currency: in strict mode prefer ratios; use an amount only if the user gives it knowingly;
   - function arguments are literals (`drawdown_from_high(252)`), bucket names must exist in the
     strategy, tags compare case-insensitively.
5. **Read it back in plain Polish** before proposing: when it fires, when it does not, and that it is
   skipped (never fires) when data is missing or stale (the YAML shape for reading back:
   `references/rule-patterns.md`).
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

## References

| File | Style | Impact | Description |
|---|---|---|---|
| [`references/expressions.md`](references/expressions.md) | copy | CRITICAL | grammar, scopes, metric catalog and limits of custom expressions; copy of the app's reference, refreshed with every cashU version |
| [`references/strategy-schema.md`](references/strategy-schema.md) | copy | HIGH | strategy.yaml keys and the params of every built-in rule kind; copy of the app's reference, refreshed with every cashU version |
| [`references/rule-patterns.md`](references/rule-patterns.md) | cheatsheet | MEDIUM | typical ideas with their scope and rule, the YAML shape of a proposal |

## See also

- `/investments-setup` - no approved strategy yet, writing or revising the whole strategy, adding the
  rule's line to `strategy.md` in the next revision.
- `/import-builder` - importing broker files.
- `/market-research` - `range_breakout` / `volume_spike` alert proposals that follow a research run.

## Self-audit checklist

Before telling the user it is done:

1. The first two boundary lines were said at the start.
2. The rule was read back in plain Polish (when it fires, when not, skipped on missing or stale data).
3. Units are right: ratios with `%` or fractions, percentage points as plain numbers, amounts only
   when the user gave them knowingly.
4. `propose_custom_rule` returned a stored proposal, and the backtest (how often, when, whether it
   fires today) was shown; the final proposal is named when there were several.
5. The message is Polish, at most 200 characters, with no "buy" / "sell" or trade instruction.
6. The user knows the approval path in the app and the line to add to `strategy.md`.
