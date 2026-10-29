---
name: market-research
description: >
  Use when the owner wants the investments module researched: the Saturday routine, a sourced note on one instrument, topic or makro, a thesis review, a full refresh, or scheduling the routine.
  Applicability - POSITIVE: held and watched instruments, topics, macro cards, candidates and theses researched through the cashU MCP server into sourced Polish notes, topic market views and model recommendations.
  Applicability - NEGATIVE: NOT for writing or revising the strategy or an instrument thesis (/investments-setup), custom rules (/extension-builder), imports (/import-builder) or placing trades.
  Triggers: /market-research, "research", "przegląd tez", "sprawdź tezę", "sprawdź tezy", "czy teza jest aktualna", "rewizja tez", "zrób pełny research od nowa", "przejrzyj wszystko jeszcze raz", "dokończ research", "dokończ przegląd tez", "zaplanuj research".
argument-hint: "[symbol | ISIN | segment | makro | tezy [symbol] | rutyna | od nowa]"
---

# market-research: the Saturday routine, on-demand notes and thesis reviews

Market research and model recommendations for the cashU investments module through the profile's
cashU MCP server. You research one profile: its held positions, its watchlist, new candidates that
match the owner's strategy, and the market segments behind them (the app's fixed catalog: gold,
bonds, crypto, sectors ...), reviewing strategy, portfolio construction and thesis health; on demand
you also review the theses of the held positions against the owner's own invalidation conditions and
exit plans. What you find always becomes notes with sources, written through the profile's MCP server
(a finding that exists only in a local file is invisible in the app); the app shows them in
Inwestycje (research strip, asset drawer, research view) and in the Sunday review. You keep one
current market view (now and outlook) under each topic thesis, then save current buy/hold/reduce/exit
recommendations, with complete held and watchlist coverage when the owner requests a full pass. After
a run you may propose a few alerts that watch for a move out of a sideways range or a volume spike.
You never place trades or predict security prices. Notes and conversation in Polish, working files in
English, regular hyphens only (never the em dash character).

## Relationship to the workspace

| The workspace CLAUDE.md and MCP server own | This skill adds |
|---|---|
| privacy level, boundaries, the MCP tool list, where files go | the research procedure per mode: routine, on-demand, full refresh, thesis review |
| the profile's cashU server and what its tools validate or refuse | source rules, rubrics and the Polish note contract |
| the `research/` folder of the workspace | research limits, briefs, topic market views, the recommendation coverage gate, alert proposals, scheduling |

## Problem -> reference mapping

| Task / question | Start with |
|---|---|
| Which mode does this request or argument mean? | this file, section Modes |
| Run the Saturday routine (`rutyna` or no argument) | [`references/weekly-routine-workflow.md`](references/weekly-routine-workflow.md) |
| Topic briefs, topic theses, topic market view, macro cards | [`references/segments-workflow.md`](references/segments-workflow.md) |
| One instrument, one segment or `makro` | [`references/on-demand-workflow.md`](references/on-demand-workflow.md) |
| `od nowa`, a full fresh pass | [`references/full-refresh-workflow.md`](references/full-refresh-workflow.md) |
| `tezy [symbol]`, do the theses still hold | this file, section Thesis review / [`references/thesis-review.md`](references/thesis-review.md) |
| Which tool, what `research_context` returns | [`references/mcp-tools.md`](references/mcp-tools.md) |
| Which sources count, coverage per instrument type, institutional estimates | [`references/sources.md`](references/sources.md) |
| Kind, polarity, thesis relation, strength, signal checklist | [`references/rubrics.md`](references/rubrics.md) |
| Note fields, Polish title and summary, briefs, duplicates | [`references/notes.md`](references/notes.md) |
| Candidates from the strategy's criteria, `add_to_watchlist` | [`references/candidates.md`](references/candidates.md) |
| Early-stage / hyper-growth company, SPAC or de-SPAC, two rankings, entry triggers and tranches, hard filters vs pro forma | [`references/candidate-evaluation-pattern.md`](references/candidate-evaluation-pattern.md) |
| `range_breakout` / `volume_spike` alert proposals | [`references/alerts.md`](references/alerts.md) |
| "Zaplanuj", how to schedule the routine | [`references/scheduling.md`](references/scheduling.md) |

## Non-negotiable

### Hard boundaries

Keep these verbatim; do not soften them:

- Not a licensed advisor.
- Recommendations are model opinions for the owner to evaluate, never decisions or orders.
- No security price predictions or price targets.
- Facts with sources.
- Never bypass paywalls or bot protection.
- Data only through MCP at the profile's privacy level.

What they mean here:

- Research notes report facts and sentiment with dated sources, nothing else. Notes never contain a
  recommendation, your own forecast, a security price prediction, price target or analyst rating
  (`references/sources.md`).
- Institutions' published forecasts of macro and market TRENDS are welcome when cited as estimates
  with who, how much and horizon (`MFW prognozuje wzrost PKB USA o 2,1 % w 2027`, the Fed dot plot,
  `IEA szacuje ...`, `IFR szacuje ...`; owner decision 2026-10-10, `references/sources.md` 5): in a
  macro or topic brief, a segment note summary and the topic market view. Never a forecast of the
  price or valuation of a security or an index, never a price target, analyst rating, analyst
  consensus or buy / sell call, never your own forecast presented as fact.
- The agent's own opinion on a topic's market lives in one place: the topic's market view under its
  thesis (`set_topic_market_view`, step 6): `assessment` = the market now, `outlook` = where the
  topic's market, adoption or demand is heading, resting on at least one quantitative industry
  estimate of market or demand growth (who, how much, horizon, with its source), plus the main risk.
  It may describe the market's expected path (`IFR szacuje ok. 575 tys. instalacji robotów rocznie w
  2028`), never the price of a security or an index, never a price target, never buy / sell wording
  (the tool refuses it).
- After the facts are stored, form your own recommendation from the current research, the owner's
  thesis and invalidation, portfolio construction, strategy and history. Save it through
  `set_recommendation`. State it as a model opinion; the owner decides what to do.
- Never imply that saving a recommendation records a decision or books a transaction.
- Public web pages only: no logins, no paywall or bot-protection workarounds; a blocked source is
  skipped and counted.
- The profile's data reaches you only through its cashU MCP server, logged in Ustawienia > Agent AI.
  Never read the data dir, `cashu.db`, backups, exports or statements (the workspace denies it; never
  look for a way around a denial), and never run `cashu` commands that print positions, balances or
  transactions.

### Privacy level

Read `privacy` from `profile_overview`:

- **Ścisły (strict, default):** weights in %, theses, tickers, dates; no amounts, no account numbers.
- **Z kwotami (amounts):** also amounts; still no account numbers or personal data.

Either way, notes contain no portfolio data at all (no amounts, weights, cost, gains, account labels,
profile name): they are about the market, and the app links them to positions. The one exception is
the closing sentence of a segment note: returns and contributions in pp exactly as `research_context`
gives them, never weights or amounts (step 6). Web search queries carry only public identifiers
(ticker, ISIN, company, sector, topic), one instrument or segment at a time, never a list of the
profile's holdings with weights.

### MCP tools

`profile_overview`, `start_research_run`, `research_context`, `set_instrument_segment`,
`research_notes`, `upsert_topic_thesis`, `add_research_note`, `set_topic_market_view`,
`finish_research_run`, `theses` / `positions` / `watchlist` (only for a missing detail),
`set_recommendation` (one instrument on demand), `set_recommendations` (the mandatory final gate of a
routine or full refresh), `alerts`, `add_alert`, `add_to_watchlist` (on explicit request only),
`search_instruments`. What each returns and when: [`references/mcp-tools.md`](references/mcp-tools.md).

If the research tools are missing, the cashU app is older than this skill: tell the user to update
the app and click `Aktualizuj workspace` (Ustawienia > Agent AI), and stop.

### Limits

- Weekly run: at most **15 notes** on held and watched instruments, on at most **6 instruments** with
  at most **2 notes** each (strength 3, `invalidates` and `fulfills` always pass), plus up to **6
  segment notes** (per segment and ISO week one brief note and one other note) and at most **2 new candidates**. The tool enforces
  the instrument and segment limits per ISO week, across runs; its refusal is expected, not an error. On demand: at most **8
  notes**. Thesis review: at most **3 notes per position**, **40** in total
  (`references/thesis-review.md`).
- Alert proposals: at most **3 per run**, **1 per instrument**, only the dynamic kinds
  (`references/alerts.md`).
- No note without news: "nothing new" is not a note.
- No duplicates of existing notes (`references/notes.md`, Duplicates); dismissed facts stay dismissed;
  a dismissed candidate is not re-proposed for 90 days.
- Notes expire after **30 days** (the default; community notes 15 days); never set a later expiry,
  except thesis-review notes: **90 days** (the quarterly review cycle) and brief notes (topics and
  macro, steps 6 / 6b): **60 days** (a brief describes a state and stays until a new one replaces it).
- Near duplicates: the tool refuses a note whose title, brief headline or opening text says the same
  as a non-dismissed note of the same instrument, candidate or segment from the last 60 days
  (`near duplicate of note <id>`): count it in `skipped`, never rephrase to get past it. A reversal or
  a new move is never a near duplicate (different polarity or thesis relation, opposite direction
  words such as `rośnie` / `spada`, `podniósł` / `obniżył`, or different numbers in the title), and a
  new brief whose `why` names changed drivers passes even with the same headline.
- Strength 3 creates an info signal and `invalidates` an action signal; `fulfills` (the outcome the
  thesis expected has happened) marks the thesis `spełniona`: run the checklist in
  `references/rubrics.md` before writing any of them.
- Time box: about 30-40 minutes. Past 60 minutes, stop gathering and finish with what you have (a
  thesis review has its own, `references/thesis-review.md`).

### Early-stage, hyper-growth and SPAC candidates

Full rules with the reasons: [`references/candidate-evaluation-pattern.md`](references/candidate-evaluation-pattern.md).

- Early business and low current revenue are never an automatic rejection: score scale potential
  (TAM, product, real deployments, contracted demand, capital to scale) and execution risk
  separately.
- Show two rankings: by potential / upside and risk-adjusted.
- Never end at "obserwuj" / czekam: say whether a small first tranche makes sense now, what must
  happen before each next tranche and which facts block entry. Tranches are fractions of the
  planned position, never of the portfolio; they are conditions for the owner, not orders.
- SPAC / de-SPAC: the shell's market cap and the pro forma post-money equity value are different
  numbers; count new shares and dilution; trust / redemption protection works before closing and
  is gone after the merger.
- A strategy hard filter may use the pro forma equity value of an announced merger, always shown
  next to the current shell value and the gap between them.
- The owner's strategy still rules: accepting early hyper-growth lifts neither the limit on small
  positions nor the need for a hard, dated catalyst.
- Facts go to cashU (`add_research_note`); assessment, outlook (horizon, main risks) and entry
  conditions stay visibly separate. The entry plan (triggers, blockers, tranches) is the owner's,
  in the instrument's thesis in the app ("Teza": Wejście, Unieważnienie, Wielkość i dokupienia):
  propose the wording, check facts against it, never write it without the owner's yes.

## Modes

Claude Code appends arguments as `ARGUMENTS:` at the end of this skill.

- **`rutyna`** (the scheduled run; the schedule's instructions are `/market-research rutyna`): the
  weekly routine below with `"scheduled": true`.
- **No arguments** (the user typed it, or the app's `Uruchom teraz` command): the weekly routine with
  `"scheduled": false`.
- **`tezy`**, optionally followed by a symbol or ISIN, or a request such as "przegląd tez", "sprawdź
  tezę", "czy teza ... jest aktualna": the thesis review (below).
- **A segment** (a key or label from the catalog such as `gold` or `Złoto i górnicy`, matched case-
  and accent-insensitively, or a request about one market segment): on-demand mode for that segment.
  An argument that is both a held or watched symbol and a segment: ask (unattended: the instrument).
- **Any other argument** (a symbol, ISIN or name) or a request about one instrument: on-demand mode.
  On-demand runs (also `makro`) are exempt from the weekly novelty limits:
  [`references/on-demand-workflow.md`](references/on-demand-workflow.md).
- **`od nowa`**, or the owner explicitly asking for a full fresh research ("zrób pełny research od
  nowa", "przejrzyj wszystko jeszcze raz"): the full refresh. Never on your own initiative and
  never in a scheduled run. Procedure: [`references/full-refresh-workflow.md`](references/full-refresh-workflow.md).
- **"Zaplanuj" / how to schedule:** `references/scheduling.md`; never create a schedule silently.

Unattended runs (scheduled, `claude -p`) have nobody to answer: never ask questions there. Skip what
needs a decision and name it in the final summary.

## The weekly routine (skeleton)

Full procedure: [`references/weekly-routine-workflow.md`](references/weekly-routine-workflow.md).

0. **Preflight:** the profile's workspace, exactly one cashU server, `profile_overview` (investments on).
1. **Open the run:** `start_research_run(scope)`, keep the `run_id`; never touch another running run
   unattended.
2. **Load the context:** `research_context`, `research_notes`; assign missing segments; plan the
   novelty budget in `research/<YYYY-MM-DD>-run.md`. `owner_review.agenda` lists the review cards the
   owner sent to you with their notes: cover each in this run (a sourced note on that topic, or one
   line in the summary saying why not).
   Upcoming events you find (earnings dates outside the US, RPP, a product launch) go on a note as
   `details.event_date` + `details.event`: the review's calendar card shows them.
3. **Held positions** and 4. **Watchlist:** sourced passes, rubrics, duplicates; notes in materiality
   order within the budget.
5. **Candidates:** only from the strategy's criteria (`references/candidates.md`), at most 2.
6. **Segments** (topic briefs, topic theses, topic market view) and 6b. **Macro briefs:**
   [`references/segments-workflow.md`](references/segments-workflow.md).
7. **Alert proposals (optional):** `references/alerts.md`, at most 3.
8. **Recommend and finish:** `set_recommendations` exactly once with `scope: "all"` (never finish
   unless it returns `missing: 0`), then `finish_research_run(run_id, counts)` and a Polish summary of
   at most 15 lines.

## Thesis review (on demand, held positions)

The owner asks whether the theses still hold (`/market-research tezy [symbol]`). Full procedure:
`references/thesis-review.md`. In short: held positions with a thesis (not drafts, not owner-named
instruments or cash; one symbol: that position only), one run over exactly those positions, sourced
facts checked field by field (invalidation, exit plan, thesis premise; price-based conditions stay
with the app's rules and alerts) in a window of at most 90 days, every changed field a note with
`thesis_relation` + `thesis_field`, `details.context` starting `Przegląd tezy:` and
`expires_in_days: 90` (at most 3 per position; no change, no note), and the long report in
`research/<YYYY-MM-DD>-thesis-review.md`, which never replaces the notes. Then save a recommendation
per reviewed position, optionally propose alerts, `finish_research_run`, then one line per position
with thesis health and the model recommendation. A revision of the thesis is `/investments-setup`.

## Working files (workspace only)

In the profile's workspace keep one file per run, `research/<YYYY-MM-DD>-run.md` (English): the plan,
items done, notes written (title and id), alerts proposed, sources blocked, open questions; a thesis
review writes `research/<YYYY-MM-DD>-thesis-review.md` instead (`references/thesis-review.md`). They
hold no amounts and no personal data, only what a note may hold. If the current folder is not a profile workspace (no
`research/` folder), keep the plan in the conversation and write no files; never write into a code
repository, `docs/` or memory files.

## Scheduling

The Saturday routine is a **local** Claude Code routine in the profile's workspace (instructions
`/market-research rutyna`), created by or with the user's explicit approval: the desktop app's local
routine (recommended; Code > Routines > New routine > Local, weekly, Saturday 07:00, folder = workspace), or for
terminal users a LaunchAgent running `cd <workspace> && claude -p "/market-research rutyna"` that the
user installs (`references/scheduling.md`). Not `/schedule` (cloud
routines cannot reach the local cashU server) and not `/loop` (session only). Show the plan, wait
for a clear yes, never create a schedule as a side effect.

## References

| File | Style | Impact | Description |
|---|---|---|---|
| [`references/weekly-routine-workflow.md`](references/weekly-routine-workflow.md) | workflow | CRITICAL | the weekly routine, steps 0-8, recommendation gate, failure handling |
| [`references/segments-workflow.md`](references/segments-workflow.md) | workflow | CRITICAL | steps 6 / 6b: topic briefs, topic theses, topic market view, macro briefs |
| [`references/on-demand-workflow.md`](references/on-demand-workflow.md) | workflow | HIGH | one instrument, segment or `makro` |
| [`references/full-refresh-workflow.md`](references/full-refresh-workflow.md) | workflow | HIGH | `od nowa`: what differs from the weekly routine |
| [`references/thesis-review.md`](references/thesis-review.md) | workflow | HIGH | the thesis review of held positions: window, per-field states, notes, report, summary |
| [`references/mcp-tools.md`](references/mcp-tools.md) | cheatsheet | HIGH | every MCP tool, what it returns, in which step |
| [`references/sources.md`](references/sources.md) | pattern | CRITICAL | per-source rules (news and company reports, community sentiment, trend data, macro), exclusions, access rules, coverage per instrument type, institutional estimates |
| [`references/rubrics.md`](references/rubrics.md) | pattern | CRITICAL | kind, polarity, thesis relation (invalidation condition and exit plan), strength 1-3, signal checklist |
| [`references/notes.md`](references/notes.md) | pattern | CRITICAL | fields, Polish title and summary, sources, segments, briefs (topics and macro), topic market view, duplicates and near duplicates, examples |
| [`references/candidates.md`](references/candidates.md) | workflow | MEDIUM | candidate criteria from the strategy, exclusions, `details` shape |
| [`references/candidate-evaluation-pattern.md`](references/candidate-evaluation-pattern.md) | pattern | HIGH | early-stage / hyper-growth scoring, two rankings, entry triggers and tranches, SPAC / de-SPAC values and dilution, hard filters vs pro forma, the owner's limits, the owner's entry plan in the thesis |
| [`references/alerts.md`](references/alerts.md) | workflow | MEDIUM | proposing `range_breakout` / `volume_spike` alerts after research: when, limits, parameters, wording |
| [`references/scheduling.md`](references/scheduling.md) | workflow | MEDIUM | the local Saturday routine (desktop app or launchd), approval rules |

## See also

- `/investments-setup` - writing or revising a strategy or a thesis, recording a decision, adding
  candidate criteria (`watchlist.criteria`).
- `/extension-builder` - price levels, drawdowns, SMA crosses and weights as the owner's own rules.
- `/import-builder` - getting broker exports into the app before there is anything to research.

## Self-audit checklist

Before telling the user it is done:

1. Every finding went into the app through `add_research_note` (and topic views through
   `set_topic_market_view`); nothing exists only in a local file.
2. Routine or full refresh: `set_recommendations` was called exactly once with `scope: "all"` before
   `finish_research_run` and returned `missing: 0`; on demand, `set_recommendation` for the held or
   watched instrument.
3. `finish_research_run` was called (also on an abort) with your own counters only.
4. No note or brief holds a recommendation or your own forecast; no note, brief or view holds a price
   target, a security or index price move, or portfolio data (except the pp sentence of a segment note);
   every institutional estimate names who, how much and horizon.
5. The limits held; refusals and duplicates were counted in `skipped`, never rephrased to pass.
6. Unattended: no question asked, no schedule created, no `add_to_watchlist`; interactive: alerts and
   watchlist additions only after an explicit yes.
7. Working files only under the workspace's `research/`, with no amounts or personal data.
8. The Polish summary names what the mode asks for (notes, signals, theses, recommendations, alerts,
   blocked sources, what to look at on Sunday).
9. Early-stage or SPAC instruments in scope: both rankings shown, no bare "obserwuj" (first tranche
   now or not, next-tranche conditions, blockers), shell vs pro forma values named, the strategy's
   size limit and catalyst rule respected, and facts checked against the owner's entry plan (or a
   proposed wording when the owner has none).
