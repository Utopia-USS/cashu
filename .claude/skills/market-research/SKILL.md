---
name: market-research
description: Weekly market research for the finanse investments module - a local Claude Code routine on Saturday (before the Sunday review) or on demand for one instrument or theme. Gathers dated facts from news and company reports, community sentiment (Reddit, X, forums; scale and direction only, flagged as noise) and trend data (ETF flows, relative strength, search trends) for held positions, the watchlist, candidates matching the strategy's entry criteria and sector / macro themes, and writes Polish notes with sources through the profile's finanse MCP server, each tied to the thesis. Use on /market-research (optionally a symbol, ISIN or theme), research or sentiment requests about holdings, or to schedule the Saturday research. Triggers on Polish requests such as "zrób research", "research tygodniowy", "co słychać w", "sentyment na", "zbadaj temat", "nowi kandydaci", "zaplanuj research". Not for strategy or theses (investments-setup), rules (extension-builder) or imports. Never recommends trades or predicts prices.
argument-hint: "[symbol | ISIN | temat | rutyna]"
---

# market-research: the Saturday routine and on-demand notes

You research one profile: its held positions, its watchlist, new candidates that match the owner's
strategy, and the sector and macro themes behind them. What you find becomes notes with sources,
written through the profile's MCP server; the app shows them in Inwestycje (research strip, asset
drawer, research view) and in the Sunday review. Notes and conversation in Polish, working files in
English, regular hyphens only (never the em dash character).

## Hard boundaries

Keep these verbatim; do not soften them:

- Not a licensed advisor.
- No buy/sell recommendations.
- No price predictions.
- Facts with sources.
- Never bypass paywalls or bot protection.
- Data only through MCP at the profile's privacy level.

What they mean here:

- You report facts and sentiment, each with a dated source. You never say or imply what to buy, sell,
  hold or how much; a weakened thesis is a count of what research found, not advice. No price targets,
  no "fair value", no forecasts, no analyst ratings (`references/sources.md`).
- If the user asks "czy kupić / sprzedać?", say in one sentence that you do not recommend trades, then
  offer the facts, the thesis check (its invalidation condition and exit plan) or `/investments-setup`
  to revise the thesis.
- Public web pages only: no logins, no paywall or bot-protection workarounds; a blocked source is
  skipped and counted.
- The profile's data reaches you only through its finanse MCP server, logged in Ustawienia > Agent AI.
  Never read the data dir, `finanse.db`, backups, exports or statements (the workspace denies it; never
  look for a way around a denial), and never run `finanse` commands that print positions, balances or
  transactions.

## Privacy level

Read `privacy` from `profile_overview`:

- **Ścisły (strict, default):** weights in %, theses, tickers, dates; no amounts, no account numbers.
- **Z kwotami (amounts):** also amounts; still no account numbers or personal data.

Either way, notes contain no portfolio data at all (no amounts, weights, cost, gains, account labels,
profile name): they are about the market, and the app links them to positions. Web search queries
carry only public identifiers (ticker, ISIN, company, sector, topic), one instrument or theme at a
time, never a list of the profile's holdings with weights.

## MCP tools

| tool | when |
|---|---|
| `profile_overview` | preflight: investments enabled, privacy level, data freshness |
| `start_research_run(scope)` | step 1: opens the run, returns `run_id` |
| `research_context` | step 2: held and watched instruments (weights as fractions, 0.12 = 12 %) with theses (entry type, thesis, invalidation, exit plan) and research state (health, last researched), themes with direction, the strategy's version and `candidate_criteria`, open and cooled-down candidates, upcoming events, the last run and a running one, limits |
| `research_notes(since?)` | step 2: notes of the last 30 days by default, dismissed ones included (never add them again), for duplicates |
| `add_research_note(...)` | steps 3-6: one note (schema in `references/notes.md`); validated, sources required, no amounts |
| `finish_research_run(run_id, counts)` | step 7, and on any abort |
| `theses(instrument)`, `positions`, `watchlist` | only if `research_context` lacks a detail you need |
| `add_to_watchlist` | on demand only, when the user explicitly asks (`references/candidates.md`) |

If the research tools are missing, the finanse app is older than this skill: tell the user to update
the app and click `Aktualizuj workspace` (Ustawienia > Agent AI), and stop.

## Limits

- Weekly run: at most **25 notes**, at most **3 per instrument or theme**, at most **3 new candidates**,
  at most **5 theme notes** (sector and macro together). On demand: at most **8 notes**.
- No note without news: "nothing new" is not a note.
- No duplicates of existing notes (`references/notes.md`, Duplicates); dismissed facts stay dismissed;
  a dismissed candidate is not re-proposed for 90 days.
- Notes expire after **30 days** (the default; community notes 15 days); never set a later expiry.
- Strength 3 creates an info signal and `invalidates` an action signal: run the checklist in
  `references/rubrics.md` before writing either.
- Time box: about 30-40 minutes. Past 60 minutes, stop gathering and finish with what you have.

## Modes

Claude Code appends arguments as `ARGUMENTS:` at the end of this skill.

- **`rutyna`** (the scheduled run; the schedule's instructions are `/market-research rutyna`): the
  weekly routine below with `"scheduled": true`.
- **No arguments** (the user typed it, or the app's `Uruchom teraz` command): the weekly routine with
  `"scheduled": false`.
- **Any other argument** (a symbol, ISIN, name or theme) or a request about one instrument or theme:
  on-demand mode.
- **"Zaplanuj" / how to schedule:** `references/scheduling.md`; never create a schedule silently.

Unattended runs (scheduled, `claude -p`) have nobody to answer: never ask questions there. Skip what
needs a decision and name it in the final summary.

## The weekly routine, step by step

**0. Preflight.** You should be in the profile's workspace (its `CLAUDE.md` names the profile, its
`.mcp.json` holds one finanse server). If several finanse servers are connected, ask which profile in
an interactive session, or stop with one line in an unattended one; never mix profiles. Call
`profile_overview`: investments must be enabled, note the privacy level. If the module is off or the
server is not connected, stop and say why.

**1. Open the run.** `start_research_run(scope)` with `{"held": true, "watchlist": true,
"candidates": true, "scheduled": true | false}` (themes are found along the way). Keep the `run_id`.
If the tool says another run is still running, do not touch it in an unattended run: stop with one
line (the app marks a run without notes for 4 hours as interrupted). In an interactive session tell
the user and close it (`finish_research_run(run_id, status="failed", reason=...)`) only after a yes.
In the workspace, start the working file `research/<YYYY-MM-DD>-run.md` (below).

**2. Load the context.** `research_context`, then `research_notes` (defaults: 30 days, dismissed
included). Plan in the working file:
- positions: with a thesis and a known upcoming or just-passed event first, then other theses by
  weight, then positions without a thesis by weight; broad index ETFs, bonds and cash only through
  issuer notices and macro themes (`references/sources.md`, coverage table); owner-named (private)
  instruments and cash are never researched;
- watched instruments: those with a draft thesis (accepted candidates) first;
- the window per instrument: since its last research date (never researched: 30 days);
- the note budget: about 15 for positions, 5 for the watchlist, 3 candidates, 5 themes.
Scheduled run only (a catch-up after a missed Saturday can land days later): if `last_run` in the
context is a `done` run that finished less than 3 days ago, finish this run at once with empty counts
and say so in the summary.

**3. Held positions.** For each planned position: read its thesis, then
- news and company reports, primary sources first (`references/sources.md` 1);
- community scale and direction where it means something (single stocks, crypto), flagged as noise
  (`references/sources.md` 2);
- trend data for its sector or region when the thesis rests on a trend (`references/sources.md` 3).
Decide kind, polarity, thesis relation (against the invalidation condition and the exit plan) and
strength with `references/rubrics.md`, check duplicates, then `add_research_note`
(`references/notes.md`). Tick the position off in the working file.

**4. Watchlist.** The same passes, lighter: at most 2 notes per instrument. The relation is `none`
unless the instrument has a (draft) thesis.

**5. Candidates.** From the strategy's criteria in `research_context` only
(`references/candidates.md`): entry types `trend`, `sentiment_correction`, `special_situation` and the
numeric thresholds. Exclude held, watched, cooled-down and recently proposed instruments. Propose only
when every numeric threshold is met and verified, with structured `details`. No criteria in the
strategy: no candidates (name it in the final summary). Never call `add_to_watchlist` here.

**6. Sector and macro themes.** Themes behind the positions, the watchlist and the candidates (sector,
region, rates, inflation, FX, regulation): official sources first, trend data with source and period.
Reuse existing theme names. A theme fact that bears on one thesis goes on that instrument's note with
the theme set.

**7. Finish.** `finish_research_run(run_id, counts)` with your own counters only (the app counts
notes, kinds and signals itself): `{"sources_checked": n, "instruments_covered": n,
"themes_covered": n, "candidates_screened": n, "skipped": n}`, where `skipped` = duplicates, blocked
sources and refused notes together. Then a short Polish summary in the session (at most 15 lines):
notes per part, notes that created signals (title and relation), weakened or invalidated theses by
symbol, blocked sources, no candidate criteria in the strategy (if so), what to look at on Sunday. No
recommendations.

If a step fails, continue with the next item. When the time box runs out, finish normally with what
is saved. If the MCP tools keep failing, finish with `status: "failed"` and a short `reason` (at most
200 characters). If the session is cut off before `finish_research_run`, the app marks the run as
interrupted after 4 hours without notes; saved notes stay, and a later on-demand run (`dokończ
research`) can pick up from the working file (duplicates are skipped).

## On-demand mode (one instrument or theme)

1. Preflight as in step 0.
2. `start_research_run(scope)` with `{"held": false, "watchlist": false, "candidates": false,
   "instruments": ["<id, symbol or ISIN>"]}`, or `"themes": ["<theme>"]` instead of `instruments`.
3. `research_context` and `research_notes`.
4. Resolve the target:
   - held or watched instrument: the passes of step 3 (window: since its last research, at most 30
     days);
   - a theme: step 6 for that theme;
   - an instrument the profile neither holds nor watches: check it against the candidate criteria
     (`references/candidates.md`); a full match becomes a `candidate` note, anything else is answered
     in the chat without a note, with the offer to add it to the watchlist (`add_to_watchlist` only
     after an explicit yes).
5. At most 8 notes, then `finish_research_run`.
6. Show the notes in the chat (title, kind, relation, strength, sources with dates) and where they are
   in the app (Inwestycje > the asset > Research, or Inwestycje > Research). Follow-up questions get
   facts with sources, under the same boundaries.

## Working files (workspace only)

In the profile's workspace keep one file per run, `research/<YYYY-MM-DD>-run.md` (English): the plan,
items done, notes written (title and id), sources blocked, open questions. It holds no amounts and no
personal data, only what a note may hold. If the current folder is not a profile workspace (no
`research/` folder), keep the plan in the conversation and write no files; never write into a code
repository, `docs/` or memory files.

## Scheduling

The Saturday routine is a **local** Claude Code routine in the profile's workspace, created by or with
the user's explicit approval (`references/scheduling.md`): recommended a local routine in the Claude
desktop app (Code > Routines > New routine > Local, weekly, Saturday 07:00, instructions
`/market-research rutyna`, folder = workspace); for terminal users a LaunchAgent running
`cd <workspace> && claude -p "/market-research rutyna"` that the user installs. Not `/schedule` (cloud
routines cannot reach the local finanse server) and not `/loop` (session only). Show the plan, wait
for a clear yes, never create a schedule as a side effect.

## References

- `references/sources.md`: per-source rules (news and company reports, community sentiment, trend
  data, macro), exclusions, access rules, coverage per instrument type.
- `references/rubrics.md`: kind, polarity, thesis relation (invalidation condition and exit plan),
  strength 1-3, signal checklist.
- `references/candidates.md`: candidate criteria from the strategy, exclusions, `details` shape.
- `references/notes.md`: fields, Polish title and summary, sources, themes, duplicates, examples.
- `references/scheduling.md`: the local Saturday routine (desktop app or launchd), approval rules.
