---
name: market-research
description: Market research and model recommendations for the cashU investments module through the profile's cashU MCP server. Reviews held positions, watchlist, strategy, portfolio construction and thesis health; writes sourced Polish research notes, then saves a current buy/hold/reduce/exit recommendation for each covered instrument. Never places trades or predicts prices.
argument-hint: "[symbol | ISIN | segment | makro | tezy [symbol] | rutyna]"
---

# market-research: the Saturday routine, on-demand notes and thesis reviews

You research one profile: its held positions, its watchlist, new candidates that match the owner's
strategy, and the market segments behind them (the app's fixed catalog: gold, bonds, crypto,
sectors ...); on demand you also review the theses of the
held positions against the owner's own invalidation conditions and exit plans. What you find always
becomes notes with sources, written through the profile's MCP server (a finding that exists only in a
local file is invisible in the app); the app shows them in Inwestycje (research strip, asset drawer,
research view) and in the Sunday review. After a run you may propose a few alerts that watch for a
move out of a sideways range or a volume spike. Notes and conversation in Polish, working files in
English, regular hyphens only (never the em dash character).

## Hard boundaries

Keep these verbatim; do not soften them:

- Not a licensed advisor.
- Recommendations are model opinions for the owner to evaluate, never decisions or orders.
- No price predictions.
- Facts with sources.
- Never bypass paywalls or bot protection.
- Data only through MCP at the profile's privacy level.

What they mean here:

- Research notes report facts and sentiment with dated sources. Notes never contain a recommendation,
  price target, forecast or analyst rating (`references/sources.md`).
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

## Privacy level

Read `privacy` from `profile_overview`:

- **Ścisły (strict, default):** weights in %, theses, tickers, dates; no amounts, no account numbers.
- **Z kwotami (amounts):** also amounts; still no account numbers or personal data.

Either way, notes contain no portfolio data at all (no amounts, weights, cost, gains, account labels,
profile name): they are about the market, and the app links them to positions. The one exception is
the closing sentence of a segment note: returns and contributions in pp exactly as `research_context`
gives them, never weights or amounts (step 6). Web search queries carry only public identifiers
(ticker, ISIN, company, sector, topic), one instrument or segment at a time, never a list of the
profile's holdings with weights.

## MCP tools

| tool | when |
|---|---|
| `profile_overview` | preflight: investments enabled, privacy level, data freshness |
| `start_research_run(scope)` | step 1: opens the run, returns `run_id` |
| `research_context` | step 2: held and watched instruments (weights as fractions, 0.12 = 12 %) with theses (entry type, thesis, invalidation, exit plan) and research state (health, last researched), each with `segment` and `segment_source`; `segments` (the owner's topics, shown as "Tematy": the portfolio's move by segment, weight, contribution and return over 1 and 4 weeks, instruments with their own 1-week return and contribution, the topic trend `trend_1w` / `trend_4w` = the equal-weighted price move of its held and watched instruments with `members` = how many have prices, `last_note_at`, `note_this_week`; topics only watched have weight 0), `currency`, `unassigned`, `segment_catalog`; `macro` (five regime cards: state, since, `summary` = the app's one-line Polish description, metrics, `note_key`) and `macro_catalog`; the strategy's version and `candidate_criteria`, open and cooled-down candidates, upcoming events, the last run and a running one, limits |
| `set_instrument_segment(instrument, segment)` | step 2: assign a catalog key to a held or watched instrument without one (`segment` is required; `null` clears your own value; an owner's value is refused) |
| `research_notes(since?)` | step 2: notes of the last 30 days by default, dismissed ones included (never add them again), for duplicates |
| `add_research_note(...)` | steps 3-6 and the thesis review: one note (schema in `references/notes.md`); validated, sources required, no amounts |
| `finish_research_run(run_id, counts)` | step 8, and on any abort |
| `theses(instrument)`, `positions`, `watchlist` | only if `research_context` lacks a detail you need |
| `set_recommendation(instrument, recommendation, reason)` | after research: save the model opinion (`buy_asap`, `buy`, `hold`, `reduce`, `exit_asap`) with its short reason |
| `alerts(status)` | step 7: live alerts, muted agent alerts and the agent alert limit, before any proposal |
| `add_alert(...)` | step 7: a proposed `range_breakout` / `volume_spike` alert (`references/alerts.md`) |
| `add_to_watchlist` | on demand only, when the user explicitly asks (`references/candidates.md`); a removed instrument comes back with its old note and research (`restored`) |
| `search_instruments(query)` | before `add_to_watchlist` when the market is not obvious: pick the exact Yahoo symbol of the listing the user means (name, ticker or ISIN) |

If the research tools are missing, the cashU app is older than this skill: tell the user to update
the app and click `Aktualizuj workspace` (Ustawienia > Agent AI), and stop.

## Limits

- Weekly run: at most **15 notes** on held and watched instruments, on at most **6 instruments** with
  at most **2 notes** each (strength 3, `invalidates` and `fulfills` always pass), plus up to **6
  segment notes** (one per segment and ISO week) and at most **2 new candidates**. The tool enforces
  the instrument and segment limits per ISO week, across runs; its refusal is expected, not an error. On demand: at most **8
  notes**. Thesis review: at most **3 notes per position**, **40** in total
  (`references/thesis-review.md`).
- Alert proposals: at most **3 per run**, **1 per instrument**, only the dynamic kinds
  (`references/alerts.md`).
- No note without news: "nothing new" is not a note.
- No duplicates of existing notes (`references/notes.md`, Duplicates); dismissed facts stay dismissed;
  a dismissed candidate is not re-proposed for 90 days.
- Notes expire after **30 days** (the default; community notes 15 days); never set a later expiry,
  except thesis-review notes: **90 days** (the quarterly review cycle).
- Strength 3 creates an info signal and `invalidates` an action signal; `fulfills` (the outcome the
  thesis expected has happened) marks the thesis `spełniona`: run the checklist in
  `references/rubrics.md` before writing any of them.
- Time box: about 30-40 minutes. Past 60 minutes, stop gathering and finish with what you have (a
  thesis review has its own, `references/thesis-review.md`).

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
- **"Zaplanuj" / how to schedule:** `references/scheduling.md`; never create a schedule silently.

Unattended runs (scheduled, `claude -p`) have nobody to answer: never ask questions there. Skip what
needs a decision and name it in the final summary.

## The weekly routine, step by step

**0. Preflight.** You should be in the profile's workspace (its `CLAUDE.md` names the profile, its
`.mcp.json` holds one cashU server). If several cashU servers are connected, ask which profile in
an interactive session, or stop with one line in an unattended one; never mix profiles. Call
`profile_overview`: investments must be enabled, note the privacy level. If the module is off or the
server is not connected, stop and say why.

**1. Open the run.** `start_research_run(scope)` with `{"held": true, "watchlist": true,
"candidates": true, "scheduled": true | false}` (segments come from the context; `held: true` makes
it a weekly run with the novelty limits). Keep the `run_id`.
If the tool says another run is still running, do not touch it in an unattended run: stop with one
line (the app marks a run without notes for 4 hours as interrupted). In an interactive session tell
the user and close it (`finish_research_run(run_id, status="failed", reason=...)`) only after a yes.
In the workspace, start the working file `research/<YYYY-MM-DD>-run.md` (below).

**2. Load the context.** `research_context`, then `research_notes` (defaults: 30 days, dismissed
included). Plan in the working file:
- segments first: every held or watched instrument with `segment` null gets one through
  `set_instrument_segment`, a key from `segment_catalog` (funds by what they hold; single stocks by
  sector when the catalog has it, else by market: `equity_pl`, `equity_em`, `equity_global`). Never
  change an `owner` or `auto` value (the tool refuses an owner's); fix your own (`agent`) only when it is
  clearly wrong; leave cash, stablecoins and owner-named instruments without one;
- positions: with a thesis and a known upcoming or just-passed event first, then other theses by
  weight, then positions without a thesis by weight; broad index ETFs, bonds and cash only through
  issuer notices and their segment (`references/sources.md`, coverage table); owner-named (private)
  instruments and cash are never researched;
- watched instruments: those with a draft thesis (accepted candidates) first;
- the window per instrument: since its last research date (never researched: 30 days);
- the novelty budget: notes on at most 6 instruments (held and watched together), 2 each, at most 15
  in total; segments up to 6; candidates 2. Positions with nothing new get nothing; each week only
  part of the portfolio has new notes.
Old notes may carry a free-text `theme` from before segments: ignore the label (their facts still
count for duplicates) and never write `theme`.
Scheduled run only (a catch-up after a missed Saturday can land days later): if `last_run` in the
context is a `done` run that finished less than 3 days ago, finish this run at once with empty counts
and say so in the summary.

**3. Held positions.** For each planned position: read its thesis, then
- news and company reports, primary sources first (`references/sources.md` 1);
- community scale and direction where it means something (single stocks, crypto), flagged as noise
  (`references/sources.md` 2);
- trend data for its sector or region when the thesis rests on a trend (`references/sources.md` 3).
Decide kind, polarity, thesis relation (against the invalidation condition and the exit plan) and
strength with `references/rubrics.md` and check duplicates. Write a note with `invalidates`,
`fulfills` or strength 3 at once through `add_research_note` (`references/notes.md`); list the
others in the working file and tick the position off.

**4. Watchlist.** The same passes, lighter: at most 2 notes per instrument. The relation is `none`
unless the instrument has a (draft) thesis. Then write the listed notes of steps 3 and 4 in
materiality order: a thesis relation first (`weakens`, then `supports`), then position weight x
strength (watched instruments after held ones), until the 6-instrument budget is used. A refusal
from the tool for the budget is expected: write nothing more for new instruments and count the rest
in `skipped`.

**5. Candidates.** From the strategy's criteria in `research_context` only
(`references/candidates.md`): entry types `trend`, `sentiment_correction`, `special_situation` and the
numeric thresholds. At most 2. Exclude held, watched, cooled-down and recently proposed
instruments. Propose only when every numeric threshold is met and verified, with structured
`details`. No criteria in the strategy: no candidates (name it in the final summary). Never call
`add_to_watchlist` here.

**6. Segments (the owner's topics).** Go through `research_context.segments`: held exposure first by
|contribution| over 1 week, then topics without exposure (watched only, or with a note) by |`trend_1w`|.
The owner follows topics, not only holdings: a watched-only topic (AI, quantum, power ...) with a
notable `trend_1w` or a dated event deserves a note as much as a held one. Per segment, ask what changed since its
`last_note_at` (and its notes in `research_notes`); official sources and hard data first
(`references/sources.md` 4). Nothing changed: no note (the app shows `bez zmian`). Otherwise one
segment note (`references/notes.md`, Segments): `segment` = the key, no instrument, kind `macro`,
`trend` or `news`, relation `none`, Polish, summary at most 400 characters: what happened in the
segment this week with dated numbers, the affected holdings by symbol, then one sentence on how it
shows in the attribution, with the 1-week figures from `research_context` (`GDXJ -4,4 % w tygodniu,
segment -0,8 pp portfela.`; no exposure: give the topic trend instead, `temat +3,2 % w tygodniu`,
or nothing when `trend_1w` is null). At most one note per segment and
ISO week (the tool refuses a second one, dismissed notes included: count it in `skipped`), at most 6
per week. Company facts stay on the instrument, never on a segment; a segment fact that bears on one
thesis gets that instrument's own note with the relation.

**6b. Macro.** Read `research_context.macro`: five regimes computed by the app from public series
(`risk` global equity, `dollar`, `em` emerging markets vs world, `commodities`, `rates` US yields and
the curve), each with `state_label`, `summary` (the app's own text for the owner: do not repeat it in a
note), `since` (null with `since_open` when the state predates the app's data:
say "since before <since_min>", never invent a start), metric texts and `last_note_at`. The state is the app's,
never yours: do not restate or dispute it. Write a macro note (`segment` = its `note_key`, e.g.
`macro_rates`) only when the state changed since its last macro note, or a dated decisive event
happened this week (a central bank decision, an official data release that moved the regime's
metric materially). Same note rules as segments (400 characters, kind `macro`, `trend` or `news`,
one per key and ISO week, counted in the 6 segment notes per week): the dated facts and the metric
values as the app shows them, official sources first (Fed, BLS, US Treasury, ECB, NBP). You may name
the portfolio's segments the mechanism touches in neutral words (`dotyczy: złoto, rynki wschodzące`);
never a forecast, never what the owner should do. A `missing` or `stale` regime gets no note.

**7. Alert proposals (optional).** Where this run's notes point to a dated catalyst or a changed
situation for a held or watched single stock, sector ETF or crypto, you may propose a
`range_breakout` or `volume_spike` alert with a short reason: at most 3 per run, by the rules in
`references/alerts.md` (unattended: created as agent alerts the owner reviews in the app; interactive:
only those the user accepts). None is fine; never a price level, a target or buy / sell wording.

**8. Recommend and finish.** For each covered held or watched instrument, compare the fresh facts with
its thesis, invalidation, exit plan, position weight, segment concentration, strategy and history. Call
`set_recommendation` with a `reason`: one or two short Polish sentences (max 280 characters, no amounts) naming
the facts it rests on; the app shows it under the thesis. Do not use price targets and do not mistake a low
price for evidence. Prefer
`hold` when evidence is incomplete. `buy_asap` and `exit_asap` require a clear, time-sensitive reason.
Then call `finish_research_run(run_id, counts)` with your own counters only (the app counts
notes, kinds and signals itself): `{"sources_checked": n, "instruments_covered": n,
"segments_covered": n, "candidates_screened": n, "skipped": n}`, where `segments_covered` = segments
checked in step 6 (with or without a note) and `skipped` = duplicates, blocked sources and refused
notes together. Then a short Polish summary in the session (at most 15 lines): notes per part
(segments with a note by label), notes that created signals (title and relation), weakened,
invalidated or fulfilled theses by symbol, recommendations changed by symbol, alerts proposed (symbol, kind, reason), blocked
sources, no candidate criteria in the strategy (if so), what to look at on Sunday.

If a step fails, continue with the next item. When the time box runs out, finish normally with what
is saved. If the MCP tools keep failing, finish with `status: "failed"` and a short `reason` (at most
200 characters). If the session is cut off before `finish_research_run`, the app marks the run as
interrupted after 4 hours without notes; saved notes stay, and a later on-demand run (`dokończ
research`) can pick up from the working file (duplicates are skipped).

## On-demand mode (one instrument, segment or makro)

1. Preflight as in step 0.
2. `start_research_run(scope)` with `{"held": false, "watchlist": false, "candidates": false,
   "instruments": ["<id, symbol or ISIN>"]}`, or `"segments": ["<key>"]` instead of `instruments`
   (on-demand runs are exempt from the weekly novelty limits).
3. `research_context` and `research_notes`.
4. Resolve the target:
   - held or watched instrument: the passes of step 3 (window: since its last research, at most 30
     days);
   - `makro`: scope `"segments"` = the five `macro_catalog` keys; step 6b, then explain in the chat
     each regime's state, since when and its metrics as `research_context.macro` gives them;
   - a segment (key or label resolved against `segment_catalog`): step 6 for that segment only, at
     most one note and only if something changed since its last one and `note_this_week` is false.
     Always explain in the chat its 1-week and 4-week move from `research_context.segments`
     (contribution, return, the holdings behind it, the currency effect); a segment missing there
     has no exposure and no active note;
   - an instrument the profile neither holds nor watches: check it against the candidate criteria
     (`references/candidates.md`); a full match becomes a `candidate` note, anything else is answered
     in the chat without a note, with the offer to add it to the watchlist (`add_to_watchlist` only
     after an explicit yes).
5. At most 8 notes; in an interactive session at most 1 alert proposal for the instrument, only if
   the user accepts it (`references/alerts.md`); then `finish_research_run`.
6. Save a recommendation for a held or watched instrument, then show the notes and recommendation in
   the chat and where they are in the app. Follow-up questions keep facts and recommendation clearly
   separated.

## Thesis review (on demand, held positions)

The owner asks whether the theses still hold (`/market-research tezy [symbol]`). Full procedure:
`references/thesis-review.md`. In short:

1. Preflight, `research_context`; pick the held positions with a thesis (not drafts, not owner-named
   instruments or cash); one symbol: that position only.
2. `start_research_run` with `{"held": false, "watchlist": false, "candidates": false, "instruments":
   [...]}` (exactly the reviewed positions), then `research_notes` for the last 90 days.
3. Per position, in a window since its last thesis review (at most 90 days): dated, sourced facts
   checked field by field against the invalidation condition, the exit plan and the thesis premise.
   Price-based conditions stay with the app's rules and alerts (except an exit plan's own written
   price level being reached: `fulfills`, `references/rubrics.md`).
4. Every field whose state changed becomes a note through `add_research_note` with `thesis_relation`
   + `thesis_field`, `details.context` starting `Przegląd tezy:` and `expires_in_days: 90`; at most 3
   per position. No change, no note.
5. The long report goes to `research/<YYYY-MM-DD>-thesis-review.md` in the workspace; it never
   replaces the notes.
6. Save a recommendation per reviewed position, optionally propose alerts, `finish_research_run`, then
   one line per position with thesis health and the model recommendation. A revision of the thesis is
   `/investments-setup`.

## Working files (workspace only)

In the profile's workspace keep one file per run, `research/<YYYY-MM-DD>-run.md` (English): the plan,
items done, notes written (title and id), alerts proposed, sources blocked, open questions; a thesis
review writes `research/<YYYY-MM-DD>-thesis-review.md` instead (`references/thesis-review.md`). They
hold no amounts and no personal data, only what a note may hold. If the current folder is not a profile workspace (no
`research/` folder), keep the plan in the conversation and write no files; never write into a code
repository, `docs/` or memory files.

## Scheduling

The Saturday routine is a **local** Claude Code routine in the profile's workspace, created by or with
the user's explicit approval (`references/scheduling.md`): recommended a local routine in the Claude
desktop app (Code > Routines > New routine > Local, weekly, Saturday 07:00, instructions
`/market-research rutyna`, folder = workspace); for terminal users a LaunchAgent running
`cd <workspace> && claude -p "/market-research rutyna"` that the user installs. Not `/schedule` (cloud
routines cannot reach the local cashU server) and not `/loop` (session only). Show the plan, wait
for a clear yes, never create a schedule as a side effect.

## References

- `references/sources.md`: per-source rules (news and company reports, community sentiment, trend
  data, macro), exclusions, access rules, coverage per instrument type.
- `references/rubrics.md`: kind, polarity, thesis relation (invalidation condition and exit plan),
  strength 1-3, signal checklist.
- `references/candidates.md`: candidate criteria from the strategy, exclusions, `details` shape.
- `references/notes.md`: fields, Polish title and summary, sources, segments, duplicates, examples.
- `references/thesis-review.md`: the thesis review of held positions: window, per-field states, notes,
  report, summary.
- `references/alerts.md`: proposing `range_breakout` / `volume_spike` alerts after research: when,
  limits, parameters, wording.
- `references/scheduling.md`: the local Saturday routine (desktop app or launchd), approval rules.
