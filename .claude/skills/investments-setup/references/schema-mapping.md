# strategy.yaml mapping (schema version 1)

Source of truth: `src/finanse/modules/investments/templates/strategy/README.md` (keys, rule kinds,
params, data limits) and the examples `passive_etf.yaml` / `blank.yaml` next to it. Custom rule
expressions: `src/finanse/modules/investments/rules/expr/EXPRESSIONS.md`. If this file and the README
disagree, the README wins; tell the user and follow it.

Validation happens in the app: `propose_strategy` validates before storing the proposal and
`strategy_status` shows the current file's issues. Unknown keys are warnings with a "did you mean" hint;
errors carry the YAML path, line and column. YAML anchors/aliases, merge keys, custom tags and duplicate
keys are errors.

## Conventions

- Weights, thresholds and bands are fractions (0.15 = 15%); only `absolute_band_pp` is in percentage
  points. Inside custom rule expressions `15%` is also accepted.
- Amounts are in `base_currency` (PLN is the supported choice).
- Comments in the YAML are English; `strategy.md` is Polish prose.
- Asset classes: `equity`, `etf`, `fund`, `bond`, `treasury_bond`, `cash`, `crypto`, `commodity`,
  `claim`, `other`.
- Never put a specific fund in the YAML as a purchase choice. Tags (`global_equity`, `bonds`, `core`,
  `satellite`, ...) are set by the user on their instruments in the app; buckets match on tags and asset
  classes. `benchmark.proxy` is a measurement proxy only.

## Amount fields in strict mode

`contributions.monthly_amount` (required, > 0, when the section exists) and
`allocation.rebalance.min_trade_value` are amounts. In strict mode ask whether the user wants to give
them here (they would go to the cloud model) or enter them in the app after approval. If not given,
write a clearly marked placeholder (`monthly_amount: 1  # PLACEHOLDER: set your monthly deposit in the
app`), list it among the defaults in the approval step, and tell the user to edit `strategy.yaml` from
the strategy popover (`Otwórz strategy.yaml`) after approving. Never invent a realistic-looking amount.

## Patterns

**Buckets are first-match.** Put the tagged global ETF bucket (`asset_class: etf, tags: [...]`) before a
catch-all active bucket (`asset_class: [equity, etf, crypto]`), then `cash`:

```yaml
buckets:
  - id: core
    match: { asset_class: etf, tags: [global_equity] }
  - id: satellite
    match: { asset_class: [equity, etf, crypto] }
  - id: cash
    match: { asset_class: cash }
```

**Wide band** like 55% +- 15 pp: set `absolute_band_pp: 15` and `relative_band` above band / smallest
target (e.g. 0.35) so only the absolute band governs.

**Cash outside the allocation:** give `cash` an explicit 0 target and watch it with `cash_level`;
restrict `allocation_drift` to the non-cash buckets via `params.buckets`:

```yaml
allocation:
  targets: { core: 0.55, satellite: 0.45, cash: 0 }
  rebalance: { absolute_band_pp: 15, relative_band: 0.35, min_trade_value: 1 }  # PLACEHOLDER amount
rules:
  - id: rebalance_check
    kind: allocation_drift
    params: { buckets: [core, satellite] }
    severity: action
  - id: idle_cash
    kind: cash_level
    params: { max_weight: 0.10 }
```

**Asset class lists in rule params** keep concentration rules off the core ETF:

```yaml
  - id: single_position_review
    kind: position_concentration
    params: { max_weight: 0.08, asset_class: [equity, crypto] }
```

**Market-dip reserve tranches** = several `drawdown_from_high` rules on the core ETF, filtered by tag
(or `instrument_ids`) so thematic ETFs do not fire them:

```yaml
  - id: dip_tranche_1
    kind: drawdown_from_high
    params: { threshold: 0.15, window_days: 252, tags: [global_equity] }
    severity: action
    cooldown_days: 30
  - id: dip_tranche_2
    kind: drawdown_from_high
    params: { threshold: 0.25, window_days: 252, tags: [global_equity] }
    severity: action
    cooldown_days: 30
  - id: dip_tranche_3
    kind: drawdown_from_high
    params: { threshold: 0.35, window_days: 252, tags: [global_equity] }
    severity: action
    cooldown_days: 30
```

**Speculative cap by tag:** `tagged_weight` with `tags` and `max_weight` (one signal for the tag set):

```yaml
  - id: speculative_cap
    kind: tagged_weight
    params: { tags: [speculative], max_weight: 0.05 }
```

**Review triggers per position:** `loss_from_cost`, `gain_from_cost`, `drawdown_from_high` with
filters (`asset_class`, `tags`, `instrument_ids`, combined with AND). They ask for a review against the
thesis, never a forced sale.

**Behavioural triggers (preferred for fallback modes):**
- missed deposits: `contribution_gap` (`period_days`, `grace_days`; needs `contributions`);
- longer inactivity or a custom combination: `custom` with `days_since_last_deposit`, e.g.
  `when: 'days_since_last_deposit > 75'` (scope portfolio);
- missed recorded reviews: not expressible yet (see below), manual.

**Custom rules** (`kind: custom`): `when` over the metric catalog, `scope` portfolio | instrument |
bucket, optional one-line `message`. Quote the expression in single quotes. Missing data never fires a
rule. Example from the template:

```yaml
  - id: invest_idle_cash
    kind: custom
    params:
      scope: portfolio
      when: 'bucket_drift_pp("core") <= -3 and cash_weight >= 5%'
      message: Core is below target and cash is waiting to be invested
```

**Watchlist** criteria keys are free numbers; the loader suggests known names (e.g.
`min_market_cap_pln`). Used by a later stage.

**Benchmark and notifications** are parsed:

```yaml
benchmark:
  id: msci_acwi
  proxy: VWCE.DE        # measurement proxy (Yahoo symbol or ISIN), not a purchase suggestion
notifications:
  immediate: [action]
  digest_weekday: sunday
```

**Data limits** (`data:`): keep the template defaults unless the user has a reason (e.g. many treasury
bonds valued at cost do not need a looser `max_price_age_days`; they are skipped by price rules anyway).

## Not expressible yet (keep as manual checks in the weekly review)

- missed-review breach (a `review_overdue` kind; reviews are recorded in the app, the rule is not there);
- turnover (X% of the portfolio traded in N days);
- benchmark-relative warnings (rolling relative performance);
- entry-type statistics (outcomes per thesis entry type; theses themselves are recorded with
  `upsert_thesis`).

Write each one in `strategy.md` under the manual checks ("ręcznie w przeglądzie tygodniowym, do czasu
wsparcia w aplikacji") with the exact check the user will do.

## Consistency checklist before `propose_strategy`

- `version: 1`, `base_currency` set; `targets` reference existing buckets and sum to 1 (+-0.001).
- Every rule id is unique and referenced in `strategy.md`; every failure mode in `strategy.md` has a
  safeguard (a rule id or a principle or a manual check).
- Amount fields: real values given by the user or marked placeholders listed in the approval step.
- `benchmark.proxy` is a measurement proxy agreed with the user.
- Only expected warnings remain after validation, and you name them to the user.
