# On-demand mode (one instrument, segment or makro)

What this is: the procedure when the user names one instrument (symbol, ISIN or name), one segment
(catalog key or label) or `makro`. Step numbers refer to the weekly routine
(`references/weekly-routine-workflow.md`); steps 6 and 6b are in `references/segments-workflow.md`.

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
   separated. An early-stage, hyper-growth or SPAC / de-SPAC instrument follows
   `references/candidate-evaluation-pattern.md`: two scores, entry conditions instead of a bare
   "obserwuj", shell vs pro forma values, and the facts checked against the owner's entry plan
   in the thesis (or a proposed wording when there is none).
