# Thesis review (on demand, held positions)

The owner asks whether the theses of the held positions still hold: `/market-research tezy` (every held
position with a thesis) or `/market-research tezy <symbol | ISIN>` (one), or a Polish request such as
"przegląd tez", "sprawdź tezy", "czy teza XYZ jest aktualna", "rewizja tez". For each position you
check dated, sourced facts against the owner's own record: the invalidation condition, the exit plan
and the thesis premise. You report the state of the thesis; you never say what to do with the position.

**The result always goes into the app as notes through MCP** (one research run, notes with
`thesis_relation` + `thesis_field`). A review that exists only as a local file is invisible in the app
and counts as not done. The long report is a local working file in the workspace, next to the notes,
never instead of them.

## Who is reviewed

- Held positions with a thesis record (`research_context`: `thesis` present, `draft` false). Order:
  positions with an open research signal or a known event in the window first, then by weight.
- Not reviewed: positions without a thesis (list them at the end with the offer of `/investments-setup`
  to write one), owner-named (private) instruments, cash, and broad index ETFs and bonds whose thesis is
  only macro (review them through the macro theme facts, still as notes on the instrument when a fact
  bears on its thesis).
- One named instrument that is watched, not held: use the on-demand mode instead (its draft thesis is
  checked there). One that is neither: say so in one line.

## Run

1. Preflight as in the weekly routine (step 0).
2. `research_context` first (read only), then pick the positions and their references.
3. `start_research_run(scope)` with `{"held": false, "watchlist": false, "candidates": false,
   "scheduled": false, "instruments": ["<id or symbol>", ...]}`: exactly the positions you review. If
   another run is running, handle it as in step 1 of the weekly routine.
4. `research_notes(since = 90 days ago)`: the earlier reviews (notes whose `details.context` starts with
   `Przegląd tezy`), the facts already written, dismissed notes.
5. Start the report `research/<YYYY-MM-DD>-thesis-review.md` (below).
6. Review each position (next section), then write its notes before moving on, so an interrupted
   review keeps what it found.
7. Optional: alert proposals (`alerts.md`), at most 3 for the whole review.
8. `finish_research_run(run_id, counts)` with `instruments_covered` = positions reviewed,
   `sources_checked`, `themes_covered`, `skipped` (duplicates, blocked sources, refused notes).
9. The summary in the chat (below).

## One position

**Window.** Since this instrument's last thesis review (the newest note with the `Przegląd tezy`
context), else since the thesis' `updated_at`; at most 90 days back, at least the last 14 days. Facts
older than the window may appear in the summary as background, never as the fact a note is about.

**Read the record.** Entry type, thesis (the premise, the "why"), invalidation condition, exit plan,
size plan. Quote the thesis, invalidation and exit plan in the report as `research_context` gives them
(already at the profile's privacy level); leave the size plan out of the report.

**Gather.** Primary sources first (`sources.md` 1): issuer disclosures and results, fund notices,
official decisions; the dated event a `special_situation` waits for; trend data with measure, source,
period and base for a `trend` entry (`sources.md` 3); community only for a `sentiment_correction`
entry, as noise (`sources.md` 2). Search with public identifiers only, one instrument at a time.

**Judge each field** with `rubrics.md` (thesis relation), in this order:

| field (`thesis_field`) | app label | possible states (report and context line) |
|---|---|---|
| `invalidation` | Unieważnienie | met (`invalidates`), closer (`weakens`), further away (`supports`), unchanged (no note) |
| `exit_plan` | Plan wyjścia | target met (`fulfills`), catalyst closer (`supports`), delayed or less likely (`weakens`), unchanged (no note) |
| `thesis` | Wejście | expected outcome happened (`fulfills`), premise confirmed (`supports`), premise undermined (`weakens`), unchanged (no note) |
| `size_plan`, `entry_type` | | only when a fact clearly bears on them (`weakens` mostly) |

- Price and technical conditions (`spadek poniżej X`, `poniżej SMA 200`, a stop) are not judged by
  research: the app's rules and alerts measure them on hard data. Write in the report that the
  condition is price-based and leave it out of the notes. One exception: an exit plan that names its
  own price level (`sprzedaję przy 120 zł`) reached by a dated close is a fact about the owner's
  written plan: `fulfills` on `exit_plan` (`rubrics.md`).
- A time-based exit plan (`koniec 2028`) is not met by the calendar alone in a note; mention the date
  in the report and the summary.
- When in doubt, the milder relation (`rubrics.md`), and say in the summary what would settle it.

**Write the notes.** One note per field whose state changed, at most **3 per position**, the most
decisive first. Each note follows `notes.md`, plus:

- `thesis_relation` = the field's state, `thesis_field` = the field (always set in this mode; a fact
  that touches no field is not a thesis-review note: leave it to the weekly routine or the report);
- `details.context` = one line for the whole position, the same on each of its notes, at most 200
  characters, starting with `Przegląd tezy:` and naming the state per field in the app's labels:
  `Przegląd tezy: unieważnienie niespełnione; plan wyjścia przesunięty (premiera 2028)`;
- `details.event` + `details.event_date` when the next dated event matters for a field;
- `expires_in_days: 90` (the quarterly review cycle; the tool's maximum), community notes 15, a note
  tied to an event that passes earlier may expire then;
- strength and the checklist for `invalidates` / `fulfills` / strength 3 exactly as in `rubrics.md`.

**No change, no note.** A position whose fields are all unchanged gets no note; the report and the chat
say `bez nowych faktów dotyczących tezy od <d.m>`. Never write a note only to show that a review ran.

**Duplicates.** A fact already in a note of the window is not written again (the tool also refuses the
same title or first source within 14 days). If the existing note already carries the field, the report
cites it (`notatka z 2.10`); if it carries a weaker relation and a new fact settles the field, the new
fact gets its own note with `Kontynuacja notatki z <d.m>.` in the summary.

## Report (workspace file, English)

`research/<YYYY-MM-DD>-thesis-review.md`, in the profile's workspace only (no `research/` folder: keep
the report in the conversation and write no file). Per position: the thesis fields quoted as written,
the window, every fact used with its date and source URL, the state per field with one line of
reasoning, the notes written (title and `note_id`), sources blocked, open questions, the next dated
event. It holds no amounts, weights, cost, gains, account labels or profile name: only what a note may
hold, plus the quoted thesis fields. Mark positions done as you go, so `dokończ przegląd tez` can resume.

## Limits

- At most 3 notes per position, at most **40 notes** per review.
- Time box: about 5 minutes per position; past 90 minutes stop gathering and finish with what is saved.
- At most 3 alert proposals per review (`alerts.md`).

## Summary in the chat (Polish, at most 20 lines)

One line per reviewed position, then the rest:

```
XYZ.WA · osłabiona · plan wyjścia: premiera przesunięta na I półrocze 2028 (ESPI 1.10) · 1 notatka
ABC.WA · aktualna · bez nowych faktów dotyczących tezy od 5.07
DEF.US · wzmocniona · wejście: przychody segmentu +18 % r/r w II kw. (raport 7.08) · 2 notatki
```

- states use the app's words: `podważona`, `osłabiona`, `spełniona`, `wzmocniona`, `aktualna` (no
  change);
- then: positions without a thesis (offer `/investments-setup`), price-based conditions left to the
  app's rules and alerts, alerts proposed (`alerts.md`), blocked sources;
- where to look: Inwestycje > the asset > Research (and Inwestycje > Research), and the report's path.

Never a recommendation: a `podważona` thesis means a fact met the owner's own condition, nothing more.
If the owner asks what to do, say in one sentence that you do not recommend trades, then offer
`/investments-setup` to revise the thesis or record a decision.
