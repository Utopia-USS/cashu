# Writing notes (Polish)

Notes are written through `add_research_note` and shown to the owner in the app: the research strip,
the asset drawer, the research view and the Sunday review. They are in Polish; this file is in English.

## Fields

| field | rule |
|---|---|
| `run_id` | the id from `start_research_run` |
| instrument | for notes about a held or watched instrument: the id, ticker with market or ISIN as `research_context` gives it |
| `candidate` | candidate notes only, instead of an instrument: `{symbol_or_isin, name, exchange, currency}` (`candidates.md`) |
| `theme` | for sector and macro notes; also set it on an instrument note that belongs to a theme you track, so the theme's 8-week trend includes it |
| `kind` | `news`, `earnings`, `community`, `trend`, `macro`, `candidate` (`rubrics.md`) |
| `polarity` | `positive`, `negative`, `neutral` (`rubrics.md`) |
| `strength` | 1-3 with the caps per kind (`rubrics.md`) |
| `thesis_relation` | `supports`, `weakens`, `invalidates`, `neutral`, `none` (`rubrics.md`) |
| `thesis_field` | `thesis`, `invalidation`, `exit_plan`, `size_plan` or `entry_type`; only with `supports` / `weakens` / `invalidates` |
| `title` | at most 120 characters |
| `summary` | at most 1200 characters |
| `sources` | 1-10 objects with exactly the keys `url`, `publisher`, `published_at`, `title` |
| `details` | optional object, only these keys: candidates `entry_type`, `criteria`, `criteria_version`, `bucket` (`candidates.md`); community `scale` (`small`, `medium`, `large`); any note `context` (one line, at most 200 characters) and `event` + `event_date` (the next dated event the note points to, `YYYY-MM-DD`). Never amounts, targets or sizes |
| `observed_at` | leave to the tool (now); the dates of the facts go into `sources` and the summary |
| `expires_in_days` | leave the default 30; community notes 15; a note tied to an event that passes earlier may expire then; never more than 30 |

The tool validates lengths, enums, sources (http(s) URL, publisher, date; paywall-bypass hosts are
refused) and refuses wording that reads like a recommendation, a rating or a price prediction. If it
refuses a note, fix the named field and retry once, then skip the note and count it in
`counts.skipped`.

## Title (at most 120 characters)

- The fact, starting with the subject: `Premiera głównego tytułu przesunięta z 2027 na I półrocze 2028`.
- Numbers with units, Polish formatting: decimal comma, `%` after a space, `pp` for percentage points,
  `r/r`, `mld $`, `pb` for basis points.
- No opinion, no question, no exclamation, no clickbait. Community titles name the venues and the
  direction: `Nastroje na forach wokół XYZ negatywne po wynikach`.

## Summary (at most 1200 characters)

1. **First paragraph = the fact** (the card shows about three lines, so the essentials fit in about
   250 characters): what happened, when (`1.10`, `30 września`), the key number, who said it.
2. **Second paragraph = the thesis:** which field the fact touches and how, quoting the thesis briefly:
   `Dotyka założenia tezy „premiery gier w 2027”.` or `Warunek unieważnienia: „odwołanie oferty”;
   spełniony komunikatem z 2.10.` For `neutral`: one line why it does not touch the thesis. For `none`:
   nothing, or `Pozycja bez zapisanej tezy.`
3. Optional: what is still unknown, and the next dated event (`wyniki III kwartału: 12.11`).

Community summaries add the venues, the sample size and `szum` with the scale (and `details.scale`).
Trend summaries add the measure, the period and the comparison base. A next dated event also goes into
`details.event` / `details.event_date` so the app can show it.

Never in a note:

- the user's portfolio data: amounts, weights, cost, gains, account labels, the profile name;
- recommendations or forecasts. Self-check every title and summary for words such as `kup`,
  `kupuj`, `sprzedaj`, `sprzedawaj`, `okazja`, `warto`, `należy`, `polecam`, `rekomend...`, `cel
  cenowy`, `cena docelowa`, `wycena godziwa`, `wzrośnie do`, `spadnie do`, `prognoz...`, `powinien
  wzrosnąć`, `dobry moment`, `tanio`, `niedowartościowana`, `na pewno`. Rewrite as a fact or drop it;
- analyst ratings, targets or consensus (`sources.md`);
- usernames, handles, quotes beyond a short phrase, anything about a private person.

Regular hyphens only (no em dash character).

## Sources

- `url`: the page you opened, copied exactly. Never invented or rebuilt.
- `publisher`: the outlet or institution as a reader knows it: `Parkiet`, `PAP Biznes`, `Reuters`,
  `Przykład SA (ESPI)`, `SEC EDGAR`, `Fed`, `GUS`, `justETF`, `Google Trends`, `forum Bankier`,
  `Reddit r/inwestowanie`.
- `published_at`: ISO date `YYYY-MM-DD` of publication; for a data page, the date of the latest data
  point used. No date, no source.
- `title`: the page's headline or a short description of the dataset.
- Order: primary source first. Two sources for strength 2 when the first is not primary; a primary
  source always for strength 3 and `invalidates`.

## Themes

- Reuse the exact theme names from `research_context` / `research_notes`, so the 8-week trend keeps
  one line per theme (the app groups case- and accent-insensitively, but keep the spelling anyway).
- A new theme: a short Polish noun phrase of at most 60 characters naming a sector, region or macro
  topic, never one company: `Miedź i metale przemysłowe`, `Stopy procentowe USA`, `Rynki wschodzące:
  przepływy ETF`, `Energia odnawialna: napływy`.
- Open a new theme only when it bears on a held or watched instrument or on a candidate.

## Duplicates

Before each note compare with `research_notes` (the last 30 days, including dismissed ones):

- the same event for the same instrument or theme (the same primary source, or the same fact from
  another outlet): **skip**, count it in `skipped`;
- a new fact in the same story (the next step of a merger, the confirmed date after a rumour): write a
  new note and say `Kontynuacja notatki z <d.m>.` in the summary;
- a fact the owner dismissed: skip it, they have seen it;
- never repeat a fact to refresh its expiry or to push it into this week's trend.

The tool also refuses a note with the same instrument, candidate or theme and the same title or the
same first source within 14 days (`duplicate of note <id>`): count it in `skipped` and move on. It
refuses `thesis_relation` other than `none` for an instrument without a thesis and for theme notes.

No news is not a note: do not write "nothing new this week" notes.

## Examples (invented)

Instrument, news, weakens the thesis through the exit plan:

```json
{
  "instrument": "XYZ.WA",
  "theme": "Gry wideo: premiery",
  "kind": "news",
  "polarity": "negative",
  "strength": 3,
  "thesis_relation": "weakens",
  "thesis_field": "exit_plan",
  "title": "Premiera głównego tytułu przesunięta z 2027 na I półrocze 2028",
  "summary": "W komunikacie z 1.10 spółka przesunęła premierę o około dwa kwartały; budżet produkcji bez zmian, harmonogram pozostałych projektów utrzymany.\n\nPlan wyjścia zakłada wyjście „po premierze w 2027 albo z końcem 2028”: nowy termin przesuwa warunek z planu wyjścia. Warunek unieważnienia („odwołanie projektu”) nie jest spełniony.",
  "sources": [
    {"title": "Raport bieżący 41/2026", "url": "https://...", "publisher": "Przykład Games SA (ESPI)", "published_at": "2026-10-01"},
    {"title": "Przykład Games przesuwa premierę", "url": "https://...", "publisher": "Parkiet", "published_at": "2026-10-02"}
  ]
}
```

Community, flagged as noise:

```json
{
  "instrument": "ABC.WA",
  "kind": "community",
  "polarity": "negative",
  "strength": 1,
  "thesis_relation": "neutral",
  "title": "Nastroje na forach wokół ABC negatywne po wynikach",
  "summary": "Forum Bankier i Reddit r/inwestowanie, 28 wpisów od 29.09 (zwykle kilka w tygodniu): przewaga negatywnych, ok. 60 %. Tematy: dywidenda i podatek sektorowy. Szum, mała skala, dużo powtórzeń.\n\nTeza dotyczy popytu na surowiec, wpisy jej nie dotykają.",
  "sources": [
    {"title": "Wątek o wynikach ABC", "url": "https://...", "publisher": "forum Bankier", "published_at": "2026-10-02"}
  ],
  "details": {"scale": "small"},
  "expires_in_days": 15
}
```

Theme, trend data:

```json
{
  "theme": "Rynki wschodzące: przepływy ETF",
  "kind": "trend",
  "polarity": "negative",
  "strength": 2,
  "thesis_relation": "none",
  "title": "Odpływy z ETF rynków wschodzących trzeci tydzień z rzędu",
  "summary": "Łączne odpływy z ETF rynków wschodzących w 3 tygodniach do 2.10: ok. 2,1 mld $. Siła relatywna szerokiego ETF EM wobec ACWI -4 pp od 1.08.\n\nDotyczy obserwowanych i posiadanych ETF EM; relacja do tez w notatkach instrumentów.",
  "sources": [
    {"title": "Weekly ETF flows", "url": "https://...", "publisher": "justETF", "published_at": "2026-10-02"}
  ]
}
```
