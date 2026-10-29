# The weekly routine, step by step

What this is: the full procedure of the Saturday routine (`rutyna`, or no arguments), steps 0-8. The
segment and macro steps (6, 6b) are in `references/segments-workflow.md`; the on-demand mode, the full
refresh and the thesis review reuse these steps.

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
In the workspace, start the working file `research/<YYYY-MM-DD>-run.md` (SKILL.md, Working files).

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

**6. Segments (the owner's topics): briefs**, topic theses and the topic market view, and **6b.
Macro: briefs**: `references/segments-workflow.md`.

**7. Alert proposals (optional).** Where this run's notes point to a dated catalyst or a changed
situation for a held or watched single stock, sector ETF or crypto, you may propose a
`range_breakout` or `volume_spike` alert with a short reason: at most 3 per run, by the rules in
`references/alerts.md` (unattended: created as agent alerts the owner reviews in the app; interactive:
only those the user accepts). None is fine; never a price level, a target or buy / sell wording.

**8. Recommend and finish.** Start with the portfolio-level priority: allocation drift, missing core
exposure and segment concentration take precedence over attractive local ideas. For each covered held
or watched instrument, compare the fresh facts with its thesis, invalidation, exit plan, position
weight, segment concentration, strategy and history. Form a recommendation with a `reason`: one or
two short Polish sentences (max 280 characters, no amounts) naming the facts it rests on; the app
shows it under the thesis. Do not use price targets and do not mistake a low price for evidence. Prefer
`hold` when evidence is incomplete, but a `hold` (czekam) on an instrument under consideration still names its entry conditions (first tranche now or not, what unlocks the next tranche, what blocks entry; `references/candidate-evaluation-pattern.md`). `buy_asap` and `exit_asap` require a clear, time-sensitive reason.
For every routine or full refresh, call `set_recommendations` exactly once after forming the opinions
and before `finish_research_run`, with `scope: "all"`. Its updates contain every recommendation that
changed in this run and every row in `research_context.positions` or `research_context.watchlist`
whose `recommendation` is null;
unchanged existing recommendations may be omitted and are preserved. The MCP call is the completion
invariant: it commits only with complete coverage and returns `expected`, `covered`, `missing` and
`updated`. Never finish or call the pass complete unless it returns `missing: 0`. Note novelty limits
do not limit recommendation coverage. Only on-demand research of one instrument uses
`set_recommendation` directly for that instrument.
Then call `finish_research_run(run_id, counts)` with your own counters only (the app counts
notes, kinds and signals itself): `{"sources_checked": n, "instruments_covered": n,
"segments_covered": n, "candidates_screened": n, "skipped": n}`, where `segments_covered` = segments
checked in step 6 (with or without a note) and `skipped` = duplicates, blocked sources and refused
notes together. Then a short Polish summary in the session (at most 15 lines): notes per part
(segments with a note by label), notes that created signals (title and relation), weakened,
invalidated or fulfilled theses by symbol, recommendations changed by symbol, alerts proposed (symbol, kind, reason), blocked
sources, no candidate criteria in the strategy (if so), for early-stage or SPAC names the two rankings (potential / upside and risk-adjusted) and which owner entry-plan triggers or blockers were hit (or which instruments have no plan yet), what to look at on Sunday.

## When something fails

If a step fails, continue with the next item. When the time box runs out, finish normally with what
is saved. If the MCP tools keep failing, finish with `status: "failed"` and a short `reason` (at most
200 characters). If the session is cut off before `finish_research_run`, the app marks the run as
interrupted after 4 hours without notes; saved notes stay, and a later on-demand run (`dokończ
research`) can pick up from the working file (duplicates are skipped).
