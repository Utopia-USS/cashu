# Writing notes (Polish)

Notes are written through `add_research_note` and shown to the owner in the app: the research strip,
the asset drawer, the research view and the Sunday review. They are in Polish; this file is in English.

## Fields

| field | rule |
|---|---|
| `run_id` | the id from `start_research_run` |
| instrument | for notes about a held or watched instrument: the id, ticker with market or ISIN as `research_context` gives it |
| `candidate` | candidate notes only, instead of an instrument: `{symbol_or_isin, name, exchange, currency}` (`candidates.md`) |
| `segment` | segment and macro notes only: a key from `segment_catalog` (`gold`, `bonds`, `semis_ai` ...) or `macro_catalog` (`macro_rates`, `macro_dollar` ...), with no instrument and no candidate (Segments below; macro notes follow the same rules, step 6b in `references/segments-workflow.md`). Never write `theme`: old notes carry one, ignore its label |
| `kind` | `news`, `earnings`, `community`, `trend`, `macro`, `candidate` (`rubrics.md`); a segment note only `macro`, `trend` or `news` |
| `polarity` | `positive`, `negative`, `neutral` (`rubrics.md`) |
| `strength` | 1-3 with the caps per kind (`rubrics.md`) |
| `thesis_relation` | `supports`, `weakens`, `invalidates`, `fulfills`, `neutral`, `none` (`rubrics.md`); a topic note only `supports` / `weakens` / `invalidates` and only when the topic has a thesis (`segments[].thesis`); a macro note always `none` |
| `thesis_field` | `thesis`, `invalidation`, `exit_plan`, `size_plan` or `entry_type`; only with `supports` / `weakens` / `invalidates` / `fulfills` (`fulfills`: `thesis` or `exit_plan` only) |
| `title` | at most 120 characters |
| `summary` | at most 1200 characters; a segment note at most 400 |
| `sources` | 1-10 objects with exactly the keys `url`, `publisher`, `published_at`, `title` |
| `details` | optional object, only these keys: candidates `entry_type`, `criteria`, `criteria_version`, `bucket` (`candidates.md`); community `scale` (`small`, `medium`, `large`); any note `context` (one line, at most 200 characters; thesis-review notes start it with `Przegląd tezy:`, `thesis-review.md`) and `event` + `event_date` (the next dated event the note points to, `YYYY-MM-DD`); every note should carry `headline`: one plain Polish sentence of 8-80 characters a beginner understands at a glance, what happened and why it matters, no figures needed (`Inwestorzy sprawdzają, ile klienci AI naprawdę zarabiają`; the app shows it first and the `title` with its figures one level deeper; never a forecast or advice); segment and macro notes may carry `brief` (Briefs below). Never amounts, targets or sizes; never the agent's own market view (that goes under the topic thesis: `set_topic_market_view`, step 6 in `references/segments-workflow.md`) |
| `observed_at` | leave to the tool (now); the dates of the facts go into `sources` and the summary |
| `expires_in_days` | leave the default 30; community notes 15; a note tied to an event that passes earlier may expire then; never more than 30, except thesis-review notes: 90 (`thesis-review.md`) and brief notes: 60 |

The tool validates lengths, enums, sources (http(s) URL, publisher, date; paywall-bypass hosts are
refused) and refuses wording that reads like a recommendation, a rating or a security price
prediction. If it
refuses a note, fix the named field and retry once, then skip the note and count it in
`counts.skipped`.

## Title (at most 120 characters)

- The fact, starting with the subject: `Premiera głównego tytułu przesunięta z 2027 na I półrocze 2028`.
- Numbers with units, Polish formatting: decimal comma, `%` after a space, `pp` for percentage points,
  `r/r`, `mld $`, `pb` for basis points.
- No opinion, no question, no exclamation, no clickbait. Community titles name the venues and the
  direction: `Nastroje na forach wokół XYZ negatywne po wynikach`.

## Summary (at most 1200 characters; segment notes 400, see Segments)

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

- the user's portfolio data: amounts, weights, cost, gains, account labels, the profile name (only
  the closing attribution sentence of a segment note, below, gives returns and pp contributions);
- recommendations or your own forecasts in the title, summary or brief. The agent's own market view
  and forward market or adoption scenario belong only under the topic thesis (`set_topic_market_view`),
  never in a note. An institution's published forecast of a macro or market trend may be cited in a
  segment or macro note's summary or brief, as an estimate with who, how much and horizon (`MFW
  prognozuje wzrost PKB USA o 2,1 % w 2027`; `sources.md` 5); never a forecast of a security's or an
  index's price or valuation. Self-check every title and summary for words such as `kup`,
  `kupuj`, `sprzedaj`, `sprzedawaj`, `okazja`, `warto`, `należy`, `polecam`, `rekomend...`, `cel
  cenowy`, `cena docelowa`, `wycena godziwa`, `wzrośnie do`, `spadnie do`, `prognoz...`, `powinien
  wzrosnąć`, `dobry moment`, `tanio`, `niedowartościowana`, `na pewno`. Rewrite as a fact or drop it
  (an attributed institutional trend forecast as above is the only exception);
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
  source always for strength 3, `invalidates` and `fulfills`.

## Segments

The app has a fixed catalog of 19 segments (`research_context.segment_catalog`), shown to the owner as
topics ("Tematy": e.g. `semis_ai` AI: chipy i centra danych, `software` AI i oprogramowanie, `quantum`,
`power` Energetyka: atom i OZE, `energy` Ropa i gaz, `metals` Metale i ziemie rzadkie, `crypto`); there
is nothing to name or invent (the old key `uranium` is now `power`). A segment note is a short market
note for the "Tematy" view:

- `segment` = the key; no instrument, no candidate; kind `macro`, `trend` or `news`;
  `thesis_relation: none`, or, when the topic has a confirmed thesis (`segments[].thesis` with
  `draft` false), `supports` / `weakens` / `invalidates` with `thesis_field: thesis`. The tool
  refuses anything else.
- At most one brief note and one other note per segment and ISO week, dismissed notes included,
  and only when something changed since the segment's last note (`last_note_at`); never a repeat of
  last week's fact.
- Summary at most **400 characters**, one paragraph: what happened in the segment, with dated numbers
  and who published them, the affected holdings by symbol, then one closing sentence linking it to the
  1-week attribution from `research_context.segments` (`GDXJ -4,4 % w tygodniu, segment -0,8 pp
  portfela.`). Returns and contributions only, never weights or amounts; no exposure: no sentence.
- Company facts (results, contracts, a fund notice) go on the instrument, never on a segment. A fact
  that bears on one thesis gets that instrument's own note with the relation. Exception: a big event
  at one company that matters for the whole topic (the CEO of the largest player killed, a sector-wide
  recall, a merger of the two biggest players) may be a topic note naming the company in the text.
- Keep your own forecasts out of the title, summary and brief, and never quote a bank's, broker's or
  fund house's forecast of prices, indices or valuations (`sources.md`). An institution's published
  forecast of a macro or market trend (IMF / OECD / World Bank GDP and inflation, Fed / ECB / NBP
  projections, IEA / EIA demand, IFR / SIA / WSTS / Gartner / IDC market or demand estimates) may be
  cited as an estimate with who, how much and horizon (`sources.md` 5). The agent's own market outlook
  belongs only in the topic's market view (`set_topic_market_view`), never in a note.

## Briefs (topics and macro)

The home page shows each topic and each macro card as plain lines "for dummies", taken from the newest
brief notes. A brief note is a segment note (topic key or `macro_*` key, rules above) with
`details.brief`:

- `headline`: 8-80 characters, one plain Polish sentence a beginner understands, the state or the
  news in words (`Rośnie popyt na chipy`, `Rynek w konsolidacji`, `Trwa hossa na giełdach`).
- `why`: at most 280 characters, plain words; for a topic: what is going on; for a macro card: why
  the state holds.
- `supports` / `risks` (macro only, 0-3 items, at most 90 characters each): "Co sprzyja" and "Na co
  uważać", conditions and facts that historically supported or weighed on such a market, named
  plainly. Topic briefs leave them out (the tool refuses them).
- Never `wzrośnie`, `urośnie`, `spadnie`, `będzie` / `będą`, `podrożeje`, `stanieje`, `potanieje`,
  `odbije`, `prognoz...`, `kupuj`, `sprzedaj`, `cel cenowy` (the tool refuses them, also without
  Polish letters): describe what is, not what will be. The one exception is a sentence citing an
  institution's published trend forecast with who, how much and horizon (`MFW prognozuje wzrost PKB
  USA o 2,1 % w 2027`, `Fed w projekcji (dot plot) zakłada stopy ok. 3,4 % na koniec 2026`, `IEA
  szacuje, że popyt centrów danych na prąd wzrośnie do ok. 945 TWh w 2030`): the tool accepts it when
  the sentence names a known institution (`sources.md` 5) and an attribution word (`prognozuje`,
  `szacuje`, `projekcja`, `według`, `dot plot`), and still refuses it with `prognozujemy` / `uważamy`,
  analysts, consensus, a rating, a call, or a price / valuation / index move (`S&P 500 wzrośnie do`,
  `wyceny spadną`, `kurs ... wzrośnie`). Each sentence is checked on its own, so an unattributed
  `Rynek będzie rósł` next to a cited forecast is still refused. Company guidance is a fact: `spółka podała
  wytyczne`, `zapowiedź spółki`, `oczekiwania firmy`.
- `expires_in_days: 60`; write a new brief when the state or the drivers changed (or on the first run
  for a topic or card without one), never to refresh an unchanged one. A new brief with the same
  state headline but a changed `why` simply becomes the shown one (the old one stays). A macro brief
  written before the card's current state began is no longer shown (the card falls back to its plain
  sentence): write a new one after a state change.
- At most one brief note per key and ISO week, counted apart from the other segment notes (one of
  each per week); a full refresh lifts it for brief notes.
- The note's title and summary stay as for any segment note (title = the fact, summary <= 400 with
  dated numbers and the attribution sentence); the brief is the beginner layer on top.

## Topic market view (`set_topic_market_view`)

Not a note: the topic's one current market view under its thesis (step 6, `references/segments-workflow.md`), with its own
sources.

| field | rule |
|---|---|
| `segment` | a `segment_catalog` key with a thesis (the owner's or your draft); macro keys are refused |
| `assessment` | 20-400 Polish characters: the topic's market now (adoption, demand, investment, cycle, valuations of the topic as a whole) |
| `outlook` | 20-400: where the market, adoption or demand is heading, resting on at least one quantitative industry estimate of market or demand growth with who, how much and horizon, as an estimate (`IFR szacuje ...`), plus the main risk. Refused without a number other than a year / horizon / quarter |
| `sources` | required, 1-6, like note sources (`url` http(s) of the page you opened, `publisher`, `published_at`, `title?`): the reports behind the estimates; they replace the stored ones |

Refused in both texts: buy / sell / hold wording, ratings, price targets, a price, quote, valuation or
index move of a security, of shares or of an index. The write replaces the previous view (the
owner's edit included).

## Duplicates

Before each note compare with `research_notes` (the last 30 days, including dismissed ones):

- the same event for the same instrument or segment (the same primary source, or the same fact from
  another outlet): **skip**, count it in `skipped`;
- a new fact in the same story (the next step of a merger, the confirmed date after a rumour): write a
  new note and say `Kontynuacja notatki z <d.m>.` in the summary;
- a fact the owner dismissed: skip it, they have seen it;
- never repeat a fact to refresh its expiry or to push it into this week's trend.

The tool also refuses a note with the same instrument, candidate or segment and the same title or the
same first source within 14 days (`duplicate of note <id>`), and a **near duplicate**: a note whose
title, brief headline or headline + opening summary says the same as a non-dismissed note of the same
instrument, candidate or segment observed in the last 60 days, in other words (`near duplicate of
note <id>: <title>`). Count both in `skipped` and move on; never rephrase a known fact to get past
the check. It never counts as a near duplicate when the polarity or the thesis relation differs, when
the texts name different directions (`rośnie` / `spada`, `podniósł` / `obniżył`, `wchodzi` /
`wychodzi`, `raises` / `cuts`) or when the titles carry different numbers: a reversal or a deeper
move is a new fact, write it. It refuses `thesis_relation` other than `none` for an instrument without a thesis, for a
topic without a thesis and for macro notes.

No news is not a note: do not write "nothing new this week" notes.

## Examples (invented)

Instrument, news, weakens the thesis through the exit plan:

```json
{
  "instrument": "XYZ.WA",
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

Segment, trend data (gold):

```json
{
  "segment": "gold",
  "kind": "trend",
  "polarity": "negative",
  "strength": 2,
  "thesis_relation": "none",
  "title": "Złoto -3,1 % w tygodniu, odpływy z ETF na złoto drugi tydzień z rzędu",
  "summary": "Cena złota (LBMA PM) 2.10 o 3,1 % niżej niż tydzień wcześniej. Globalne ETF na złoto: odpływy ok. 1,4 mld $ w 2 tygodniach do 2.10 (World Gold Council). Spółki wydobywcze spadły mocniej niż metal. Dotyczy GDXJ: -4,4 % w tygodniu, segment -0,8 pp portfela.",
  "sources": [
    {"title": "Gold ETF flows: September 2026", "url": "https://...", "publisher": "World Gold Council", "published_at": "2026-10-02"},
    {"title": "LBMA Gold Price", "url": "https://...", "publisher": "LBMA", "published_at": "2026-10-02"}
  ]
}
```

Macro brief, global equity in a bull market:

```json
{
  "segment": "macro_risk",
  "kind": "macro",
  "polarity": "positive",
  "strength": 2,
  "thesis_relation": "none",
  "title": "Zyski spółek z S&P 500 w III kwartale +12 % r/r, wydatki na AI rekordowe",
  "summary": "Według FactSet zyski spółek z S&P 500 w III kwartale wzrosły o ok. 12 % r/r (dane z 3.10). Czterej najwięksi operatorzy chmury zwiększyli nakłady inwestycyjne na centra danych o ok. 60 % r/r (raporty kwartalne). Pięć największych spółek odpowiada za ok. 30 % wartości indeksu.",
  "sources": [
    {"title": "Earnings Insight", "url": "https://...", "publisher": "FactSet", "published_at": "2026-10-03"}
  ],
  "details": {
    "brief": {
      "headline": "Trwa hossa na giełdach",
      "why": "Spółki zarabiają coraz więcej, a wielkie firmy technologiczne dużo wydają na sztuczną inteligencję.",
      "supports": ["Banki centralne obniżają stopy", "Zyski spółek rosną"],
      "risks": ["Wyceny są wysoko, więc rynek jest wrażliwy na złe wiadomości", "Wzrosty opierają się na kilku wielkich spółkach"]
    }
  },
  "expires_in_days": 60
}
```

Topic brief, chips (`semis_ai`):

```json
{
  "segment": "semis_ai",
  "kind": "trend",
  "polarity": "positive",
  "strength": 2,
  "thesis_relation": "none",
  "title": "Sprzedaż półprzewodników w sierpniu +21 % r/r (SIA)",
  "summary": "Według SIA światowa sprzedaż półprzewodników w sierpniu wzrosła o 21 % r/r, najmocniej w segmencie pamięci i układów do centrów danych (dane z 6.10). Dotyczy SMH: +2,1 % w tygodniu, segment +0,3 pp portfela.",
  "sources": [
    {"title": "Global Semiconductor Sales Increase", "url": "https://...", "publisher": "SIA", "published_at": "2026-10-06"}
  ],
  "details": {
    "brief": {
      "headline": "Rośnie popyt na chipy",
      "why": "Firmy budują centra danych dla sztucznej inteligencji i kupują coraz więcej układów; sprzedaż chipów jest wyraźnie wyższa niż rok temu."
    }
  },
  "expires_in_days": 60
}
```

Topic briefs, games (`games_media`), two weeks apart:

```json
{"details": {"brief": {"headline": "Według nowych badań ludzie grają więcej", "why": "Raport Newzoo pokazuje, że gracze spędzają przy grach więcej czasu niż rok temu, głównie na telefonach."}}}
{"details": {"brief": {"headline": "Mniej pieniędzy napływa do branży gier", "why": "Inwestorzy wykładają mniej na nowe studia; wartość transakcji w branży jest najniższa od kilku lat."}}}
```

Topic brief with one company's big event, health insurers (`healthcare`):

```json
{
  "segment": "healthcare",
  "kind": "news",
  "polarity": "negative",
  "strength": 3,
  "thesis_relation": "none",
  "title": "Zabójstwo prezesa UnitedHealthcare, akcje ubezpieczycieli zdrowotnych w dół",
  "summary": "4.12 w Nowym Jorku zastrzelono prezesa UnitedHealthcare (policja NY). W kolejnych dniach akcje największych ubezpieczycieli zdrowotnych w USA spadły o kilka procent, a w mediach wróciła krytyka odmów wypłat. Dotyczy XLV: -1,8 % w tygodniu, segment -0,2 pp portfela.",
  "sources": [
    {"title": "...", "url": "https://...", "publisher": "Reuters", "published_at": "2024-12-05"}
  ],
  "details": {
    "brief": {
      "headline": "Ubezpieczyciele zdrowotni pod presją po zabójstwie prezesa",
      "why": "Zabójstwo szefa największego ubezpieczyciela w USA wywołało falę krytyki odmów wypłat i spadki akcji całej branży."
    }
  },
  "expires_in_days": 60
}
```

Segment, macro (bonds):

```json
{
  "segment": "bonds",
  "kind": "macro",
  "polarity": "positive",
  "strength": 2,
  "thesis_relation": "none",
  "title": "RPP obniżyła stopę referencyjną o 25 pb do 4,25 %",
  "summary": "Rada Polityki Pieniężnej 1.10 obniżyła stopy o 25 pb; stopa referencyjna 4,25 % (komunikat NBP). Inflacja CPI we wrześniu 2,9 % r/r (szybki szacunek GUS, 30.09). Rentowność 10-letnich obligacji skarbowych 5,05 % na zamknięciu 2.10, -14 pb w tygodniu. Dotyczy OBL.WA: +0,9 % w tygodniu, segment +0,1 pp portfela.",
  "sources": [
    {"title": "Komunikat po posiedzeniu RPP", "url": "https://...", "publisher": "NBP", "published_at": "2026-10-01"},
    {"title": "Szybki szacunek wskaźnika cen towarów i usług konsumpcyjnych we wrześniu 2026", "url": "https://...", "publisher": "GUS", "published_at": "2026-09-30"}
  ]
}
```
