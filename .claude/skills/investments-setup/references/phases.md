# Phase guides and question banks

Ask 1-3 questions per message, one topic at a time. Use the question tool with options for multiple
choice and read free-text "Other" answers carefully. Questions are written here in English; ask them in
the user's language. Every phase ends with: summary -> confirmation -> notes -> `interview-state.md`.

Units: in amounts mode use the user's currency; in strict mode use percent of the portfolio, months of
expenses and multiples of the monthly surplus, and do not ask for absolute amounts (the user may still
volunteer them).

User types used below: **E** experienced with history in the app, **X** experienced without imported
history, **B** beginner / from zero, **P** already passive.

---

## Phase 1 - Financial base (~10 min)

Goal: how much and how regularly the user can really invest, and what must never be touched.

Data first (only for enabled modules): `cashflow_summary(12)` (savings rate %, income/expense ratio,
months with deficit), `recurring_payments` (fixed costs as a share of spending), `loans_summary` (rate,
remaining months, share of income), `networth_breakdown` (bucket shares, asset/liability ratio). Show
what the app already knows and ask only for the gaps.

Questions:
- Income type and stability: employment / contract / own business; how variable month to month.
- Monthly spending and monthly surplus (strict: surplus as a percent of income, or "how many months of
  surplus is a typical big purchase").
- Cash held, in months of expenses (strict) or amount (amounts mode); where it sits and whether it
  earns interest.
- Debts and their rates (skip what `loans_summary` already shows).
- Big expenses in 1-5 years; dependants.

Notes:
- Clarify net vs gross for contractors and the self-employed; planned changes of legal form affect tax
  wrappers (IKZE limit for the self-employed: look it up online with a source).
- Compute and state plainly: cash in months of expenses vs a typical cushion range (rule of thumb, not
  advice).
- B: explain the cushion and why investing starts after it. E/P: keep it short.
- Output: `situation.md` "Financial base"; open question "cushion size" if undecided (decide in phase 5/6).

## Phase 2 - Goals and horizon (~10 min)

Questions:
- Age (drives wrapper payout ages).
- What the money is for, amounts (strict: relative to today's portfolio or to yearly expenses), dates,
  priorities. Goals with different horizons are separate buckets.
- The **benchmark** the user wants to be judged against: global equity market / inflation + margin /
  none. Note the trade-off: cash or bonds lag an equity benchmark in good years by design.

Notes:
- "No specific goal" at a young age often hides an unnamed one (home, family). Test it with one
  concrete scenario: "in N years you want X and the portfolio is down 25%: what do you do with this
  money?"
- B: explain horizon and why money needed within ~3-5 years usually does not sit in equities
  (mechanism, not a recommendation).

## Phase 3 - Inventory (~15 min)

Data: `setup_status("investments")` (accounts, imports), `portfolio_overview` (weights by bucket,
cash weight, freshness), `positions` (per instrument weight, unrealized %, tags, valuation mode,
holding days), `networth_breakdown` (investments vs other assets and liabilities).

Questions:
- All accounts per broker with type (taxable, IKE, IKZE, PPK, OIPE). Compare with the app's account
  labels; anything missing is added by the user in the app or with `cashu invest accounts add`.
- Other assets: treasury bonds, crypto, real estate, deposits, claims. Where idle cash sits and whether
  it earns interest.
- History: E has it in the app. X: offer the import now (cashU format or simple CSV in the app's
  import drawer, any other format with the `import-builder` skill); reconciliation against the
  broker's position snapshot happens in the app's import preview, and the user confirms it there.
  B/P: usually nothing to import.

Compute and present (facts only): per-account and total weights, concentration (top 1/2/3/5),
currencies, cash share, asset classes, unclassified instruments (they need a bucket or tags in the
app), valuation modes (treasury bonds at cost, claims manual), unrealized % (relevant to any broker
migration). Costs and behaviour come in phase 4.

Do not show behavioural analysis yet (that is phase 4, after phase 5).

## Phase 5 - Risk profile and style (~10 min, before phase 4 when history exists)

Scenarios with the user's **own** numbers (amounts mode: currency from the portfolio value; strict:
percent and months of expenses, e.g. "-20% of the portfolio is about N months of your expenses" when
the user gave the ratio):
- Market-wide drop -20% in 3 months, cause stated: "whole market, no company news".
- -35% lasting a year.
- A single large position -50% on company news (name the user's largest single stock weight from
  `positions`, without judging it).

Specify the cause in every scenario, otherwise users answer "it depends on why". Then:
- How much cash would they really deploy in a downturn, and what floor they would never go below
  (= cushion).
- Capacity (facts: debts, income stability, cushion, horizon) vs willingness (declarations). Name both.
- Time budget per week/month, and when (day, time).
- Style: where ideas come from; individual stocks vs broad market. "Show me the data" is a valid answer
  and makes phase 4 decisive.

Per type: B gets fewer scenarios and more explanation of drawdowns and recovery times (with sources);
P focuses on "would you keep the standing transfer during a year-long drop".

Save the answers before any history is shown.

## Phase 4 - Retrospective (~20 min; short or skipped for B)

Describe, do not judge. Methodology, metric list and caveats: `retrospective.md`. Then ask for context
on the 2-3 most striking facts (long gaps, bursts of trades, best winners: "what was the thesis?").
Users may correct your framing of their words: update the notes with the correction and re-derive the
conclusions.

Output `history-retrospective.md`: facts, user context, **failure modes** (each with evidence and a
safeguard expressible as a YAML rule or a `strategy.md` principle), strengths to preserve.

State contradictions between phase-5 declarations and the history directly and neutrally, then draw
the design consequence (e.g. "the plan must work without your engagement at that moment").

## Phase 6 - Strategy choice (~20 min)

Show 2-3 archetypes fitted to phases 1-5, for example: passive core with bonds/cash; core + satellite
with capped stock picking; rules-based active stock picking. Comparison table with the user's own
numbers:

| row | content |
|---|---|
| split | target weights per bucket |
| bad year | approximate loss in a bad year (amounts mode: currency; strict: percent and months of expenses), using the worst historical period of the benchmark (online, with source) and what the retrospective showed |
| time | hours per month |
| half a year of doing nothing | what happens to the plan |
| measured edge | how much of the edge seen in phase 4 it keeps |
| failure modes | which ones it protects against |

Add: in a 2008-type crash every variant falls deeply.

**Two-mode pattern (worked well):** a primary mode the user wants plus a pre-agreed fallback mode with
objective breach triggers. Prefer **behavioural triggers** (missed recorded reviews, missed deposits)
over performance triggers: in the real run, rolling 24/36-month relative-performance thresholds from
-10 to -30 pp would all have fired at the trough right before the account's best year. Test candidate
thresholds on the user's history before adopting them; offer performance as warnings + review instead.

Testing a threshold: `propose_custom_rule(kind_or_expression, params, reason)` returns how often the
rule would have fired on this profile's history. If the tool offers a dry-run / backtest-only option,
use it. Otherwise each call creates a pending proposal: say so, put "backtest only" in `reason`, and
tell the user they can reject it in the app once the final strategy proposal contains the rule.

Parameter checklist (ask only what is still open):
- allocation targets and bands; what the non-active part holds (asset classes and tags, never a
  specific fund);
- contributions: amount, day, standing order;
- how idle cash enters: lump sum / spread / part kept as a market-dip reserve in tranches; cite the
  lump-sum vs DCA evidence with a source; give a rule for when the reserve is never triggered;
- single-position limit (a review, not a forced sale);
- size filter and cap for small/speculative names;
- pre-buy checklist: thesis and entry type, invalidation condition, exit plan, position size / add-on
  plan (these become thesis records);
- review triggers: loss from cost, drawdown from high, gain from cost;
- turnover rule (X% in N days -> justification + waiting period; manual until supported);
- tax wrappers: what goes inside and why, current-year limits and deadline (online, with source);
- broker migration: security transfer vs selling (fees on both sides, tax, process; online);
- how crypto is treated;
- benchmark proxy (a Yahoo symbol or ISIN as a measurement proxy, not a purchase suggestion).

Mechanism worth explaining for wrappers: realized gains inside IKE/IKZE are tax-free, so active trading
benefits more than an accumulating ETF held for decades (which defers tax anyway); losses inside cannot
offset gains elsewhere. Verify current rules and limits online every year.

When the user proposes something their own data contradicts (e.g. a new entry type that historically
underperformed), show the numbers, accept their decision, and make it measurable (tag and track it
separately, review it at the annual review).

## Phase 7 - Writing the strategy (~15 min)

`strategy.md` (Polish), sections: cel, horyzont, benchmark, przekonania i przewaga, tryby (primary and
fallback with triggers), alokacja, wejście, przegląd i wyjście, limity, gotówka (poduszka, rezerwa,
plan wejścia), wpłaty, konta i podatki, krypto, czego unikam, tryby awarii (tabela: tryb -> dowód ->
zabezpieczenie), rytm, zasady zmian, minimum na czas braku zainteresowania, kontrole ręczne w
przeglądzie tygodniowym (things the schema cannot express yet).

`strategy.yaml`: `schema-mapping.md`. Then the approval flow in SKILL.md (read back in 10 lines, list
defaults, `propose_strategy` with a changelog `reason` and market context, approval in the app).

## Phase 8 - Monitoring protocol (~5 min)

- Rhythm table: weekly (30-60 min, the app's weekly review on the digest weekday), first Sunday of the
  month (+ deposit, entry-plan tranche, allocation), quarterly (all theses, result vs benchmark,
  entry-type outcomes, strategy change proposals), annual (strategy review timed before the wrapper
  deadline). A review counts only when recorded (`mark_review_done`, or `Oznacz przegląd jako zrobiony` in the
  app).
- Change rules: e.g. proposals collected during the quarter, decided at quarterly/annual reviews with a
  changelog entry; no changes during a drop above 10% without a 14-day wait; mode switches follow their
  own rule.
- Minimum during disinterest: standing transfer; decide explicitly whether purchases are automated (some
  brokers offer recurring investment plans: check online). If not, write down the consequence (cash
  piles up, the idle-cash rule fires) and the first action after a fallback switch.
- Notifications in the shape the app expects: `notifications: { immediate: [action], digest_weekday:
  sunday }`.
- The interview counts as the first review: theses + `mark_review_done` with the start-up checklist.

---

## Question bank by type (quick reference)

| phase | E | X | B | P |
|---|---|---|---|---|
| 1 | gaps only (app data) | gaps only | full, explain cushion | gaps only |
| 2 | benchmark + hidden goal test | same | explain horizon buckets | benchmark |
| 3 | reconcile app data, unclassified instruments | import first | accounts to open | wrappers, contributions |
| 5 | three scenarios, deploy cash, time | same | one or two scenarios, explain drawdowns | standing transfer during a long drop |
| 4 | full `history_metrics` | qualitative | skip | contribution regularity, drawdown behaviour |
| 6 | three archetypes, two-mode | same | simple passive archetypes | keep or simplify |
