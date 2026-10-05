<!-- Copy shipped with this skill, generated from the finanse sources; do not edit it here. -->

# Custom rule expressions

`kind: custom` rules describe their condition in a small expression language. It is designed to be safe
by construction: a hand-written tokenizer, parser, type checker and evaluator (no Python `eval`, `exec` or
`compile`), no attribute access, no imports, no loops, no assignments, and only the metrics listed below
can be read. Anything else is rejected when the strategy is loaded, with the column of the problem.

```yaml
rules:
  - id: small_position_dip
    kind: custom
    severity: action
    cooldown_days: 30
    params:
      scope: instrument            # portfolio (default) | instrument | bucket
      tags: [satellite]            # optional filters (scope instrument): asset_class, tags, instrument_ids
      when: 'drawdown_from_high(252) >= 20% and weight < 3%'
      message: Deep drop in a small position; review the thesis   # optional, one line, <= 200 chars
```

Quote the expression in YAML when it contains `:` or `#`, or starts with a quote (single quotes outside,
double quotes inside work well). Code: `compile_expression(text, scope)` and `evaluate(compiled, resolver)`
in `finanse.modules.investments.rules.expr`.

## Grammar

```
condition      := or_expr                       (must be true/false and use at least one metric)
or_expr        := and_expr ( "or" and_expr )*
and_expr       := not_expr ( "and" not_expr )*
not_expr       := "not" not_expr | comparison
comparison     := additive ( compare_op additive )?          (no chains: a < b < c is an error)
compare_op     := "<" | "<=" | ">" | ">=" | "==" | "!="
additive       := multiplicative ( ( "+" | "-" ) multiplicative )*
multiplicative := unary ( ( "*" | "/" ) unary )*
unary          := ( "-" | "+" ) unary | primary
primary        := NUMBER | PERCENT | TEXT | "true" | "false"
                | NAME                                        (a metric variable)
                | NAME "(" [ literal ( "," literal )* ] ")"  (a metric function, literal arguments only)
                | "(" or_expr ")"

NUMBER   := digits [ "." digits ] | "." digits              e.g. 3, 0.15, .5 (no exponent, no "_")
PERCENT  := NUMBER "%"                                      e.g. 15% = 0.15 (no space before %)
TEXT     := '"' chars '"' | "'" chars "'"                   one line, no backslash escapes, <= 100 chars
NAME     := letter ( letter | digit | "_" )*                ASCII, must not start with "_"
```

Keywords are lowercase: `and`, `or`, `not`, `true`, `false`. Whitespace (spaces, tabs, newlines) is free.

Precedence, lowest first: `or`, `and`, `not`, comparisons, `+ -`, `* /`, unary `- +`. So
`not a > 1 and b < 2` means `(not (a > 1)) and (b < 2)`, and `1 + 2 * 3` is 7.

## Types

Every expression part is a number, text or a condition (true/false), checked before the rule runs:

- `+ - * /` and unary `- +` take numbers; `< <= > >=` compare numbers;
- `==` and `!=` compare two values of the same type (text with text, e.g. `asset_class == "etf"`);
  a text literal compared with `asset_class` must be a known asset class;
- `and`, `or`, `not` take conditions; the whole expression must be a condition;
- function arguments must be literals of the declared type (`drawdown_from_high(252)`, not
  `drawdown_from_high(100 + 152)`), whole numbers within the declared range.

Numbers are exact decimals (`0.1 + 0.2 == 0.3` is true). Comparisons treat numbers closer than 1e-9 as
equal, so a value exactly on a threshold does not fire because of floating-point noise in derived ratios
(the built-in rules use the same tolerance).

## Missing data (three-valued logic)

A metric whose data is missing or untrustworthy (stale price, no FX rate, unknown cost basis, too much of
the portfolio unclassified, no deposits yet, ...) is *unknown*, with the same reason the built-in rule
would give. Unknown propagates through arithmetic and comparisons. `and` is false as soon as one side is
false, `or` is true as soon as one side is true, whatever the unknown sides are; `not unknown` is unknown.
Division by zero is unknown too.

- result true -> the rule fires (one signal per scope);
- result false -> not fired (an open signal of that scope resolves);
- result unknown -> skipped with the reasons; an open signal stays untouched, nothing new fires.

So a rule fires only when its condition holds for every possible value of the missing data.

## Limits

| limit | value |
|---|---|
| expression length | 1000 characters |
| tokens | 200 |
| nesting depth (parentheses, unary operators, calls, operator chains) | 24 |
| function arguments | 10 |
| name length | 64 |
| number literal length | 24 characters |
| text literal length | 100 characters |
| `window_days` | 2 - 2520 bars |

Rejected with a clear error (examples): `__import__("os")` (names cannot start with `_`), `weight.real`
(attribute access), `x[0]` (indexing), `a = 1` (use `==`), `2 ** 8`, `a && b`, `1e9`, `lambda: 1`,
`weight > 1; 2`, non-ASCII characters outside text, chained comparisons, unknown names (with a "did you
mean" hint), metrics outside their scope.

## Scopes

| scope | evaluated | dedup key (one open signal each) |
|---|---|---|
| `portfolio` | once | rule id |
| `instrument` | once per held instrument (summed across accounts, filters applied, cash-like instruments only with `asset_class: cash`) | rule id + instrument |
| `bucket` | once per strategy bucket (or the `buckets` subset); needs buckets and targets | rule id + bucket |

Portfolio metrics are available in every scope.

## Metric catalog

Units: ratio = a fraction (0.15 = 15%, shown as a percentage in messages), pp = percentage points,
amount = base currency, price = the instrument's currency.

| metric | type | unit | scopes | meaning |
|---|---|---|---|---|
| `total_value` | number | amount | all | Portfolio value in the base currency (holdings + cash). |
| `cash_value` | number | amount | all | Cash balances plus cash-like instruments (asset_class cash), base currency. |
| `cash_weight` | number | ratio | all | cash_value / total_value (same definition as the cash_level rule). |
| `stale_weight` | number | ratio | all | Share of the portfolio valued with stale prices. |
| `unclassified_weight` | number | ratio | all | Share of the portfolio in holdings that match no strategy bucket. |
| `max_position_weight` | number | ratio | all | Weight of the largest instrument position (cash-like instruments excluded). |
| `holdings_count` | number | count | all | Number of distinct instruments held (cash-like instruments excluded). |
| `days_since_last_deposit` | number | days | all | Calendar days since the newest deposit in any account. |
| `monthly_contribution` | number | amount | all | contributions.monthly_amount from the strategy. |
| `bucket_weight(bucket)` | number | ratio | all | Current weight of a bucket. |
| `bucket_target(bucket)` | number | ratio | all | Target weight of a bucket (allocation.targets). |
| `bucket_drift_pp(bucket)` | number | pp | all | Bucket weight minus target in percentage points (positive = overweight). |
| `bucket_value(bucket)` | number | amount | all | Value of a bucket in the base currency. |
| `tagged_weight(tag, ...)` | number | ratio | all | Summed weight of holdings that carry ALL the given tags. |
| `asset_class_weight(asset_class)` | number | ratio | all | Summed weight of holdings of one asset class (cash also counts cash balances). |
| `symbol` | text | text | instrument | Ticker symbol (or the name when there is no symbol). |
| `asset_class` | text | text | instrument | Asset class wire name, e.g. "etf". |
| `currency` | text | text | instrument | Trading currency, e.g. "USD". |
| `mic` | text | text | instrument | Exchange code, e.g. "XWAR". |
| `weight` | number | ratio | instrument, bucket | Instrument scope: the instrument's weight across accounts. Bucket scope: the bucket's weight. |
| `market_value` | number | amount | instrument | Market value across accounts, base currency. |
| `cost_basis` | number | amount | instrument | Cost basis across accounts, base currency at trade-date FX. |
| `unrealized_pct` | number | ratio | instrument | (market_value - cost_basis) / cost_basis; -0.25 = down 25% from cost. |
| `unrealized_value` | number | amount | instrument | market_value - cost_basis, base currency. |
| `last_close` | number | price | instrument | Newest close in the instrument's currency. |
| `drawdown_from_high(window_days)` | number | ratio | instrument | 1 - last close / highest close of the last window_days bars (0.15 = 15% below the high). |
| `price_change(window_days)` | number | ratio | instrument | last close / first close of the last window_days bars - 1 (0.1 = up 10%). |
| `price_vs_sma(window_days)` | number | ratio | instrument | last close / average close of the last window_days bars - 1 (negative = below the average). |
| `holding_has_tag(tag)` | boolean | flag | instrument | True when the instrument carries the tag. |
| `bucket_id` | text | text | bucket | Id of the bucket being evaluated. |
| `target` | number | ratio | bucket | Target weight of the bucket. |
| `drift_pp` | number | pp | bucket | weight - target in percentage points (positive = overweight). |
| `drift_rel` | number | ratio | bucket | (weight - target) / target; unknown when the target is 0. |
| `value` | number | amount | bucket | Bucket value, base currency. |
| `drift_value` | number | amount | bucket | value - target x total_value: positive = above target (to sell), negative = to buy. |

`bucket` arguments must name a bucket defined in the strategy (checked by the loader, with a hint).
`tag` arguments compare case-insensitively, like bucket `match.tags`.

When metrics are unknown (same reasons as the built-in rules):

- weights (`weight`, `cash_weight`, `bucket_*`, `tagged_weight`, `asset_class_weight`,
  `max_position_weight`, `unclassified_weight`): a currency without a usable FX rate, an unpriced holding,
  stale prices above `data.max_stale_weight`, or an empty portfolio; bucket and tag metrics also while
  unclassified holdings exceed `data.max_unclassified_weight`; a bucket holding negative cash;
  `cash_weight` / `cash_value` while any account has negative cash;
- instrument values (`weight`, `market_value`, `unrealized_*`): the instrument's price is missing or stale,
  or its currency has no usable FX rate; `cost_basis`, `unrealized_*`: the cost basis is unknown;
  `unrealized_*`: the instrument is valued manually (a frozen holding at 0 would show -100%);
- price series (`last_close`, `drawdown_from_high`, `price_change`, `price_vs_sma`): the holding is valued
  manually or at cost (claims, frozen holdings, treasury bonds), no series, the last close older than
  `data.max_price_age_days`, fewer bars than `window_days`, or no usable FX rate;
- `days_since_last_deposit`: no deposit recorded; `monthly_contribution`: no `contributions` plan;
  `mic`: the instrument has no exchange code; `drift_rel`: the target is 0.

## Signals

A fired custom rule produces a signal whose message is `message` (or `Condition met: <when>`), prefixed
with the instrument (`PKN: ...`) or bucket (`Bucket bonds: ...`), followed by the values of every metric
the expression uses, e.g. `PKN: Deep drop in a small position; review the thesis
(drawdown_from_high(252) 22.0%, weight 1.8%).`. The payload carries `scope`, `when` and `values` (metric
label -> value; ratios and percentage points as numbers, days and counts as integers, amounts
and prices as exact decimal text, unknown as null).
