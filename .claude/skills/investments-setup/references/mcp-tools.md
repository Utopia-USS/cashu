# MCP tools by phase

What this is: which tool of the profile's `cashu-<slug>` MCP server the interview and the check-in call, and when.

| tool | when |
|---|---|
| `profile_overview` | session start: modules, privacy level, base currency, data freshness |
| `setup_status("investments")` | session start: accounts, strategy, first import, first run |
| `strategy_status` | session start, phase 7, check-in: validation issues (line/col), rules, inactive rules, versions |
| `networth_breakdown` | phase 1/3: bucket shares, asset/liability ratio, 12-month change |
| `cashflow_summary(months)`, `recurring_payments` | phase 1 (budget module on): savings rate, deficits, fixed costs |
| `loans_summary` | phase 1 (loans module on): rates, remaining months, share of income |
| `portfolio_overview` | phase 3, check-in: weights vs targets, drift, cash weight, freshness, last run |
| `positions` | phase 3, check-in: weights, unrealized %, tags, valuation mode, holding days |
| `history_metrics` | phase 4 only (after phase 5 is saved): see `references/retrospective.md` |
| `theses(instrument?)` | phase 6/8, check-in |
| `signals(status)` | check-in |
| `propose_strategy(yaml, md, reason)` | phase 7, approved strategy changes |
| `propose_custom_rule(kind_or_expression, params, reason)` | phase 6: backtest a candidate threshold |
| `upsert_thesis(...)` | phase 8 start-up checklist, check-in |
| `record_decision(signal_id, action, reason)` | check-in |
| `mark_review_done(notes, module="investments")` | end of the interview (first review), every check-in |

## Not done here

Imports are not done here: exports in the cashU format, a simple CSV or a format an approved
connector reads go through the app's import drawer; other formats through the `import-builder` skill,
which opens with one question: (a) "Daj mi plik z wartościami" (the agent reads the export) or (b)
recommended: a connector written without seeing values, approved once in the app. The user's answer
decides. One custom rule on its own: `extension-builder`.
