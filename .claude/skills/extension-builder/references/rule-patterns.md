# Rule patterns

What this is: typical monitoring ideas with the scope and rule that express them (all compile with the
app's checker), and the YAML shape a proposal ends up as. Grammar and metric catalog:
`references/expressions.md`; built-in rule kinds: `references/strategy-schema.md`.

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

## YAML shape

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
