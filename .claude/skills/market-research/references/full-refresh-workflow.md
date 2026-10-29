# Full refresh (`od nowa`, only when the owner asks)

What this is: the differences between the weekly routine (`references/weekly-routine-workflow.md`)
and a full refresh. Steps 6 and 6b: `references/segments-workflow.md`.

A complete fresh pass over everything after the owner changed a lot (new topics, new theses) or asked
for it explicitly. Same steps as the weekly routine, with these differences:

1. `start_research_run` with `{"held": true, "watchlist": true, "candidates": true, "full_refresh":
   true}`: the weekly novelty caps (6 instruments x 2 notes, 6 segment notes) and the one-brief-note-
   per-key-and-week rule do not apply, so every topic and card can get its brief even after a note
   earlier this week; the duplicate and near-duplicate checks and one non-brief note per segment and
   week still do. Never `scheduled: true` together with `full_refresh` (the tool refuses).
2. Read `research_notes(since=<60 days ago>)` first and keep it open: never restate a fact already
   there in other words (the tool refuses near duplicates too; count them in `skipped`). A refresh
   adds what is missing or changed, it does not rewrite what is still current.
3. Cover everything: a macro brief for every regime without a current one (6b), a brief for every held
   topic and every watched topic with something material (6), a draft thesis for each held topic
   without one, a current market view under every topic thesis (6), and every held and watched instrument with something material (3, 4). Save a current
   recommendation for every held and watched instrument, even when no new note is warranted.
   Candidates as usual (at most 2).
4. Recommendations, `finish_research_run` and the summary as in step 8; the summary says it was a full
   refresh and what was skipped as already known.
