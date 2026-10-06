<!-- Copy shipped with this skill, generated from the cashU sources; do not edit it here. -->

# Strategy templates

Default `strategy.md` (the written strategy, prose, in Polish) and `strategy.yaml` (machine-readable targets
and rule parameters, comments in English) templates. Each investments profile gets its own editable copy.
Never put personal numbers here; this folder is committed.

| template | for |
|---|---|
| `passive_etf.yaml` + `passive_etf.md` | starter: one global equity ETF, bond ETFs, treasury bonds, cash; rebalance, concentration, idle cash, market dip, missed deposit and one custom rule; benchmark and notifications |
| `blank.yaml` + `blank.md` | empty scaffold: version, base currency, data limits; every other section commented out with examples |

Every template must load without errors or warnings (the cashU test suite).
Code: `cashu.modules.investments.strategy.load_strategy(yaml_text, md)`; templates:
`cashu.modules.investments.templates.strategy_template(name)`.

## strategy.yaml reference (version 1)

Weights, thresholds and bands are fractions (0.15 = 15%); only `absolute_band_pp` is in percentage points.
Unknown keys are warnings with a "did you mean" hint. Every issue carries the YAML path, line and column.
YAML anchors/aliases, merge keys (`<<`), custom tags and duplicate keys are errors.

| key | required | meaning |
|---|---|---|
| `version` | yes | schema version, `1` |
| `base_currency` | yes | ISO code; PLN is the supported choice (other codes give a warning) |
| `horizon_years` | no | 1-100 |
| `contributions` | no | `monthly_amount` (> 0, required in the section), `day_of_month` (1-31) |
| `data` | no | `max_price_age_days` (default 5), `max_stale_weight` (0-1, default 0.05), `max_unclassified_weight` (0-1, default 0.02), `max_fx_age_days` (default 10), `max_unverified_days` (default 14, `null` = never); see "Data limits" below |
| `buckets` | no | list of `{id, match}`; ids unique (letters, digits, `_ . -`); first match wins; `match` keys `asset_class`, `tags` (all required), `mic`, `currency`, `instrument_ids`, each one value or a list; `match: {}` = catch-all |
| `allocation` | no | `targets` (bucket id -> weight, must reference buckets, sum to 1 +-0.001; a bucket without a target gets 0 and a warning), `rebalance` (`absolute_band_pp` 5, `relative_band` 0.25, `min_trade_value` 0) |
| `rules` | no | list of `{id, kind, params, severity, cooldown_days, polarity}`; ids unique (letters, digits, `_ . -`); `severity` `info` (default) or `action`; `cooldown_days` >= 0; `polarity` `positive`, `negative` or `neutral` overrides the kind's default (positive: `drawdown_from_high`, `gain_from_cost`; neutral: `custom`, `allocation_drift`; negative: every other kind) |
| `watchlist` | no | `criteria`: criterion -> number (used by a later stage) |
| `benchmark` | no | `id` (required, id characters), `proxy` (required: a Yahoo symbol or ISIN of an instrument tracking the benchmark), `currency` (default `base_currency`); used by a later stage |
| `notifications` | no | `immediate`: severities that notify at once (default `[action]`, `[]` = none), `digest_weekday`: `monday` ... `sunday` (default `sunday`) |

Asset classes: `equity`, `etf`, `fund`, `bond`, `treasury_bond`, `cash`, `crypto`, `commodity`, `claim`, `other`.

### Rule kinds (`params`)

Per-instrument kinds (`position_concentration`, `loss_from_cost`, `gain_from_cost`, `drawdown_from_high`,
and `custom` with `scope: instrument`) take optional filters, combined with AND, same semantics as bucket
`match`: `asset_class` (one or a list), `tags` (the instrument must carry all of them, case-insensitive),
`instrument_ids` (one or a list). Cash-like instruments (`asset_class: cash`) are only checked when
`asset_class` names `cash`. Positions are summed across accounts.

| kind | params | fires when |
|---|---|---|
| `allocation_drift` | `absolute_band_pp`, `relative_band`, `min_trade_value` (default from `allocation.rebalance`), `buckets` (subset) | per bucket: abs drift > band pp OR relative drift > band, and drift value >= min trade value |
| `position_concentration` | `max_weight` (required), filters | an instrument's weight across accounts > max |
| `loss_from_cost` | `threshold` (0-1, required), filters | an instrument is down >= threshold from cost |
| `gain_from_cost` | `threshold` (> 0, required), filters | an instrument is up >= threshold from cost |
| `drawdown_from_high` | `threshold` (0-1, required), `window_days` (bars, default 252), filters | last close >= threshold below the window's highest close |
| `cash_level` | `min_weight`, `max_weight` (at least one) | cash share outside the range |
| `contribution_gap` | `period_days` (31), `grace_days` (10) | no deposit for period + grace days, or no deposit at all (needs `contributions`) |
| `tagged_weight` | `tags` (one or a list, required), `max_weight` (required) | holdings carrying all the tags together weigh more than max (one signal for the tag set) |
| `custom` | `when` (required), `scope` (`portfolio` default, `instrument`, `bucket`), `message`; filters for scope instrument, `buckets` for scope bucket | the condition is true (one signal per scope: portfolio, instrument or bucket) |

Rules never fire on stale or missing data: they skip with a reason, and a skip never resolves an open
signal.

### Custom rules (`kind: custom`)

`when` is a condition in a small, safe expression language (no code execution): numbers (`0.15`, `15%`),
`true`/`false`, `and`/`or`/`not`, comparisons `< <= > >= == !=`, arithmetic `+ - * /`, parentheses, text
in quotes, and a fixed catalog of metrics (variables such as `weight`, `cash_weight`,
`days_since_last_deposit`; functions with literal arguments such as `drawdown_from_high(252)`,
`bucket_drift_pp("global_equity")`, `holding_has_tag("core")`). Which metrics exist depends on `scope`.
Errors name the column of the expression; unknown names get a "did you mean" hint.

```yaml
- id: small_position_dip
  kind: custom
  params:
    scope: instrument
    tags: [satellite]
    when: 'drawdown_from_high(252) >= 20% and weight < 3%'
    message: Duży spadek małej pozycji; sprawdź tezę
```

When a metric's data is missing or stale, the rule only fires if the condition is true whatever the
missing value is (otherwise it skips with the reason). The grammar and the full metric catalog are in
`expressions.md`.

## Data limits (`data:`)

Every key is optional; the defaults apply when the key or the whole section is absent.

| key | default | effect |
|---|---|---|
| `max_price_age_days` | 5 | a close older than this many calendar days is stale; per-instrument rules skip it, its value counts towards the stale share |
| `max_stale_weight` | 0.05 | `allocation_drift`, `position_concentration`, `cash_level` and `tagged_weight` skip while stale prices cover more than this share of the portfolio |
| `max_unclassified_weight` | 0.02 | `allocation_drift` and `tagged_weight` skip while holdings that match no bucket (freshly imported instruments without tags or with a guessed asset class) are more than this share of the portfolio, listing them; otherwise every classified bucket would look underweight |
| `max_fx_age_days` | 10 | an FX rate older than this many calendar days (relative to the date it is needed for) counts as missing; a holding or cash balance in that currency is left out of the total, so the weight rules skip, and per-instrument rules skip instruments priced in that currency |
| `max_unverified_days` | 14 | an open rule or alert signal that no run confirmed for more than this many days (its check kept skipping: stale price, stale share, invalid strategy) closes as expired (`closed_reason: unverified`); it starts no cooldown and opens again on the next run that fires it; `null` keeps such signals open |

Independent of these limits: negative cash in an account (deposits missing from the imported history) counts as
0 in totals and weights and makes `cash_level` (and the bucket holding it in `allocation_drift`) skip until the
history is complete.
