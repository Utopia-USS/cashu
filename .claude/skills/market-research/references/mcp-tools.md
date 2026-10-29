# MCP tools of the research skill

What this is: the cashU MCP tools this skill calls, what each returns or does, and in which step of
the flow it is used (steps: `references/weekly-routine-workflow.md`, step 6 / 6b:
`references/segments-workflow.md`).

| tool | when |
|---|---|
| `profile_overview` | preflight: investments enabled, privacy level, data freshness |
| `start_research_run(scope)` | step 1: opens the run, returns `run_id` |
| `research_context` | step 2: held and watched instruments (weights as fractions, 0.12 = 12 %) with theses (entry type, thesis, invalidation, exit plan) and research state (health, last researched), each with `segment` and `segment_source`; `segments` (the owner's topics, shown as "Tematy": the portfolio's move by segment, weight, contribution and return over 1 and 4 weeks, instruments with their own 1-week return and contribution, the topic trend `trend_1w` / `trend_4w` = the equal-weighted price move of its held and watched instruments with `members` = how many have prices, `last_note_at`, `note_this_week`; topics only watched have weight 0), `currency`, `unassigned`, `segment_catalog`; `macro` (five regime cards: state, since, `summary` = the app's one-line Polish description, metrics, `note_key`, `plain` = the app's beginner sentence shown until a brief exists, `brief` = the active macro brief or null) and `macro_catalog`; per topic also `briefs` (the brief notes the owner reads under the topic, newest first) and `thesis` (the owner's topic thesis or your draft, or null); the strategy's version and `candidate_criteria`, open and cooled-down candidates, upcoming events, the last run and a running one, limits |
| `set_instrument_segment(instrument, segment)` | step 2: assign a catalog key to a held or watched instrument without one (`segment` is required; `null` clears your own value; an owner's value is refused) |
| `research_notes(since?)` | step 2: notes of the last 30 days by default, dismissed ones included (never add them again), for duplicates; a full refresh reads 60 days |
| `upsert_topic_thesis(segment, thesis, invalidation?)` | step 6: a DRAFT thesis for a held topic without one (once); never over the owner's thesis (the tool refuses) |
| `add_research_note(...)` | steps 3-6 and the thesis review: one note (schema in `references/notes.md`); validated, sources required, no amounts |
| `set_topic_market_view(segment, assessment, outlook, sources)` | step 6: the topic's one current market view under its thesis (`Ocena teraz` / `Perspektywa` in the app); the outlook cites a quantitative industry estimate, `sources` 1-6 required; replaces the previous one; needs a thesis or your draft |
| `finish_research_run(run_id, counts)` | step 8, and on any abort |
| `theses(instrument)`, `positions`, `watchlist` | only if `research_context` lacks a detail you need |
| `set_recommendation(instrument, recommendation, reason)` | on-demand research of one instrument: save its model opinion (`buy_asap`, `buy`, `hold`, `reduce`, `exit_asap`) with a short reason |
| `set_recommendations(scope, recommendations)` | mandatory final gate for a routine or full refresh: submit changed recommendations and every context row whose recommendation is null; omitted existing recommendations are preserved, and the whole call is refused unless coverage is complete |
| `alerts(status)` | step 7: live alerts, muted agent alerts and the agent alert limit, before any proposal |
| `add_alert(...)` | step 7: a proposed `range_breakout` / `volume_spike` alert (`references/alerts.md`) |
| `add_to_watchlist` | on demand only, when the user explicitly asks (`references/candidates.md`); a removed instrument comes back with its old note and research (`restored`) |
| `search_instruments(query)` | before `add_to_watchlist` when the market is not obvious: pick the exact Yahoo symbol of the listing the user means (name, ticker or ISIN) |
