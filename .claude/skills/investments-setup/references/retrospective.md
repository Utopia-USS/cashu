# Phase 4 - retrospective from `history_metrics`

The app computes the retrospective locally from the imported history and returns conclusions through
`history_metrics`, already redacted for the profile's privacy level (strict: percent, days, counts; no
amounts). You never parse exports, fetch price series or rebuild the account value yourself: no scripts,
no raw files. Call `history_metrics` only after the phase 5 answers are confirmed and saved.

If the history is short or missing (`setup_status` first import not done, or the tool reports too little
data), say so and run phase 4 qualitatively from the user's memory, or offer the import first.

## What `history_metrics` returns and what to ask about it

| metric | what it shows | follow-up question (context, not judgment) |
|---|---|---|
| activity gaps (days) | periods without trades or deposits; list gaps > 120 days | "What was happening then? Why did the interest drop?" |
| deposits per year (count) | regularity of contributions | "Was there a standing transfer? What stopped it?" |
| sells after drawdowns | sales made after a price drop (count, depth) | "What did you expect when you sold?" |
| buys after run-ups | buys after a strong rise (momentum) vs after a drop (dip) | "Where did the idea come from?" |
| price +30 / +90 / +180 days after sales (%) | what the sold instruments did next | "Where did the money go after the sale?" |
| winners vs losers holding days | how long closed winners and closed losers were held | "How did you decide to close a losing position?" |
| fees as % of turnover | trading cost level | facts only; compare with the current fee table of the broker (online, with source) |
| concentration over time (%) | largest position and top 3 at each year end | "Was the concentration deliberate?" |

Complementary facts from other tools (allowed any time after phase 5): `positions` (open positions:
unrealized %, holding days, weight; open losers and how long held), `portfolio_overview` (today's
concentration and cash weight), `signals` history.

## Not measured by the app yet

The original methodology also used the metrics below. Until `history_metrics` provides them, do not
compute them from raw data; mark them "not measured" in `history-retrospective.md` and, where useful,
ask the user qualitatively:

- XIRR of the account vs a same-cash-flow simulation in a global ETF (same deposits, same days), with and
  without custody fees; year-by-year return vs the benchmark; max drawdown of both.
- P/L per instrument, the share of total P/L from the top 2 positions, the result without them vs the
  benchmark (luck vs repeatable edge question).
- Every action (buys, sells, deposits) inside each benchmark drawdown > 10%, up to recovery.
- Sales and buys measured against the benchmark (not only the instrument's own price).
- Rolling 24/36-month relative performance (used to test breach thresholds; until then prefer
  behavioural triggers and backtest custom rules with `propose_custom_rule`).
- Custody per year and the dividend withholding tax rate (ask the user or look up the broker's fee
  table online).

## Method

1. One-line status ("Analizuję historię, to chwilę potrwa"), then call `history_metrics`.
2. Present facts first, strongest first, in a short table. No adjectives about the user.
3. Ask for context on the 2-3 most striking facts.
4. Compare with the phase 5 declarations. State each contradiction directly and neutrally, one sentence
   of design consequence. Example: "W scenariuszu -35% przez rok zadeklarowałeś dokupowanie. W
   historii, w podobnym okresie, był 9-miesięczny okres bez wpłat i bez transakcji. Wniosek dla planu:
   musi działać bez Twojego zaangażowania w takim momencie."
5. Derive failure modes with the user. Each gets evidence and a safeguard that is either a YAML rule
   (see `schema-mapping.md`) or a `strategy.md` principle; anything not expressible goes to the manual
   checks of the weekly review.
6. Name strengths to preserve (e.g. long holding of winners, low costs).
7. Summary -> confirmation -> write `history-retrospective.md` -> update `interview-state.md`.

## `history-retrospective.md` layout

```
# History retrospective - <profile slug> (as of YYYY-MM-DD, privacy level: strict|amounts)
## Facts (from history_metrics, as of ...)
## User context (their words, corrections applied)
## Contradictions with phase 5 declarations
## Failure modes
| mode | evidence | safeguard (rule id or strategy.md principle) |
## Strengths to preserve
## Not measured (see retrospective.md)
```

## Interpretation caveats to state

- A sold stock that kept rising is not automatically a mistake (the money went somewhere else).
- Small samples: a handful of trades does not establish a pattern.
- A result driven by two positions says little about a repeatable edge.
- Higher volatility than the benchmark changes what a "good" result means.
- Data gaps (missing deposits in the import, frozen or manually valued holdings) distort the metrics:
  name them when the tool reports them.
