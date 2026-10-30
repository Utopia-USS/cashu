# Segments and macro: briefs, topic theses, topic market views

What this is: steps 6 and 6b of the weekly routine (`references/weekly-routine-workflow.md`), also used
by the on-demand mode for a segment or `makro` and by the full refresh. Note fields and the brief
contract: `references/notes.md` (Segments, Briefs, Topic market view); institutional estimates:
`references/sources.md` 5.

## 6. Segments (the owner's topics): briefs

Go through `research_context.segments`: held exposure
first by |contribution| over 1 week, then topics without exposure (watched only, or with a note) by
|`trend_1w`|. The owner reads each topic on the home page as a few short lines "for dummies" (the
`briefs`), not numbers: what is going on in the topic, in words a beginner understands
(`Rośnie popyt na chipy`, `Rynek w konsolidacji`, `Według nowych badań ludzie grają więcej`, `Mniej
pieniędzy napływa do branży`). The owner follows topics, not only holdings: a watched-only topic (AI,
quantum, power ...) deserves a brief as much as a held one.

Per topic, ask what changed since its newest brief (`briefs[0]`, `last_note_at`, `research_notes`);
official sources and hard data first (`references/sources.md` 4). Write a **brief note** when the
topic's state or its main drivers changed, or on the first run for a topic without any brief;
otherwise nothing (no "bez zmian" note). A brief note is a segment note (`references/notes.md`,
Segments and Briefs): `segment` = the key, no instrument, kind `macro`, `trend` or `news`, Polish,
summary at most 400 characters with the dated facts and how it shows in the attribution (the 1-week
figures from `research_context`: `GDXJ -4,4 % w tygodniu, segment -0,8 pp portfela.`; no exposure: the
topic trend, `temat +3,2 % w tygodniu`, or nothing when `trend_1w` is null). Add
`details.brief`
`{headline, why}`: `headline` 8-80 characters, one plain sentence; `why` at most 280 characters, what
is going on and why, in plain words. `expires_in_days: 60`. Never your own forecast or a call in a
brief (the tool refuses `wzrośnie`, `urośnie`, `spadnie`, `będzie`, `podrożeje`, `stanieje`, `odbije`,
`prognoz*`, `kupuj`, `sprzedaj`, `cel cenowy`), except in a sentence that cites an institution's
published trend forecast as an estimate, naming who, how much and the horizon (`IEA szacuje, że popyt
centrów danych na prąd wzrośnie do ok. 945 TWh w 2030`; the institution list and rules:
`references/sources.md` 5); the tool lets such a sentence through and still refuses `prognozujemy`,
analysts, consensus and any price, valuation or index move. Company guidance is a fact, worded
without `prognoza`: `spółka podała wytyczne na kwartał`, `zapowiedź spółki`, `oczekiwania firmy`.

A topic brief may name one company when a big event at it matters for the whole topic (the CEO of the
largest health insurer killed, a sector-wide recall, a merger of the two biggest players): name the
company in the text; the company's own facts still go on its instrument note when it is held or
watched. Small company news never makes a topic brief.

Per segment and ISO week at most one brief note and one other note (the tool counts them apart and
refuses a second one of the same kind, dismissed notes included: count it in `skipped`); at most 6
segment notes per week across topics and macro (a topic note that `invalidates` its topic thesis
always passes). The first briefs for many topics and cards do not all fit one weekly run: write them
most material first (held topics by exposure, cards whose state changed) and leave the rest for the
next weeks; only a full refresh writes them all at once. A segment fact that bears on one
instrument's thesis gets that instrument's own note with the relation.

### Topic theses

A topic may carry the owner's thesis (`segments[].thesis`). When it has one that is
not a draft (`draft` false), a topic note may carry `thesis_relation` `supports`, `weakens` or
`invalidates` (`thesis_field` `thesis`), judged against the thesis and its invalidation like an
instrument thesis (`references/rubrics.md`); without a thesis, or while it is still your unconfirmed
draft, the relation is `none` (the tool refuses otherwise). For a held topic without a thesis
(`thesis` null) propose one draft, once, through `upsert_topic_thesis(segment, thesis,
invalidation?)`: two or three plain Polish sentences on what has to stay true for the topic and what
would break it, no forecast, no price; the owner sees it as `[do potwierdzenia]` and confirms or edits
it. Never overwrite the owner's thesis (the tool refuses). A draft the owner deleted is a rejection:
the topic is listed in `research_context.topic_thesis_cooldown` and the tool refuses a new draft for it
for 90 days; do not try.

### Topic market view (mandatory, kept current)

The owner reads your opinion of each topic's market
directly under its thesis, not in the notes: `Ocena teraz` and `Perspektywa`
(`segments[].thesis.assessment`, `.outlook`, `.view_updated_at`, `.view_sources`). After researching a
topic that has a thesis (the owner's or your draft), call `set_topic_market_view(segment, assessment,
outlook, sources)` when the topic has no view yet, or when this run's facts change it; otherwise leave
it. `assessment` (20-400 Polish characters): the topic's market now, interpreting the facts (adoption,
demand, investment, cycle, valuations of the topic as a whole), not a repeat of a note. `outlook`
(20-400): where the topic's market, adoption or demand is heading, and it must rest on at least one
quantitative estimate of market or demand growth from an industry source, cited with who, how much
and horizon (IFR robot installations, IEA power demand, SIA / WSTS chip sales, Gartner / IDC spending,
company-reported backlog; `references/sources.md` 5), plus the main risk that would make it wrong.
Present an estimate as an estimate (`IFR szacuje ...`, `według IEA ...`), never as certainty; prefer
the newest edition, and when two institutions differ say so. The tool refuses an outlook without a
number other than a year or a horizon: `outlook needs a sourced quantitative market or demand estimate
(who, how much, horizon)`. `sources` (1-6, required, same shape and rules as note sources: the report
or release you opened, `publisher`, `published_at`) are the reports behind the estimates; they replace
the stored ones and the owner sees them as small links under the view. Example:

```json
{"segment": "robotics",
 "assessment": "Adopcja robotów przemysłowych przyspiesza w logistyce i elektronice, a Chiny odpowiadają za ponad połowę instalacji; wyceny tematu jako całości są wysokie.",
 "outlook": "IFR szacuje wzrost globalnych instalacji robotów przemysłowych do ok. 575 tys. rocznie w 2028 (z ok. 540 tys. w 2024). Ryzykiem jest słabszy cykl inwestycyjny w przemyśle i cła.",
 "sources": [{"title": "World Robotics 2025", "url": "<the IFR press release you opened>", "publisher": "IFR", "published_at": "2025-09-25"}]}
```

(The figures in the example only show the shape: always take the numbers, edition and date from the
source you opened.) Never a price, valuation or quote move of a security, of shares or of an index
(`kurs ... wzrośnie`, `akcje ... spadną`, `S&P 500 wzrośnie do`), never a price target, analyst
forecast or consensus, never buy / sell / hold wording: the tool refuses them. The write replaces the
previous view, the owner's edit included, so read the current one first and keep what still holds.
A topic without a thesis gets no view: propose the draft thesis first (held topics) or leave it.
Count views in the final summary.

### Topic valuation (held topics; when the figures changed)

The owner sees, next to `Teraz` and `Perspektywa`, whether the topic is priced cheaply or richly **for its
growth**; the app derives that word from figures you store, never from your opinion. For every held topic
(`segments[].weight > 0`) whose `segments[].valuation` is missing or older than 4 weeks, or whose figures
moved, put `details.valuation` on **that week's segment note of the topic** (a topic takes one segment note a
week: add the valuation to the note you write about the topic anyway; when nothing else changed, the
valuation note is the week's note), with `expires_in_days: 60` so the figures stay shown between refreshes:

- `pe`: the trailing P/E of the topic as a whole (a fund's or index's weighted P/E, from its factsheet or
  the index provider), `forward_pe`: the forward (next 12 months) P/E from the same source,
  `eps_growth`: the expected yearly earnings growth as a decimal fraction (35 % a year is 0.35),
  `pe_avg_5y`: the 5-year average P/E when the source gives it, `basis`: what the figures describe in a
  few words (`ETF ROBO, średnia ważona`, `indeks MSCI World Semiconductors`). At least `pe` or `forward_pe`.
- One source per figure set, the page you opened (factsheet, index fact sheet, provider data page);
  take every number from it, never compute your own, never mix two sources in one note.
- `headline` states a fact in plain words, never cheap / expensive (the app says that):
  `Robotyka: rynek wycenia szybki wzrost zysków`; `title` with the figures
  (`Robotyka: P/E 60, forward P/E 20, wzrost zysków ok. 45 % r/r`).
- Forward figures rest on analysts' earnings estimates: say so in the summary (`według konsensusu
  zebranego przez ...`) and name the date; never a price target, rating or buy / sell wording.

```json
{"kind": "trend", "segment": "robotics", "strength": 2, "polarity": "neutral", "expires_in_days": 60,
 "title": "Robotyka: P/E 60, forward P/E 20, wzrost zysków ok. 45 % r/r",
 "summary": "Według karty funduszu ... (stan na ...) średnie ważone P/E spółek wynosi 60, forward P/E 20 ...",
 "details": {"headline": "Robotyka: rynek wycenia szybki wzrost zysków",
             "valuation": {"pe": 60, "forward_pe": 20, "eps_growth": 0.45, "pe_avg_5y": 32, "basis": "ETF ROBO, średnia ważona"}},
 "sources": [{"title": "<the factsheet you opened>", "url": "<its URL>", "publisher": "<fund or index provider>", "published_at": "<its date>"}]}
```

(The figures only show the shape.) Count valuation notes in the final summary.

## 6b. Macro: briefs

Read `research_context.macro`: five regimes computed by the app from public
series (`risk` global equity, `dollar`, `em` emerging markets vs world, `commodities`, `rates` US
yields and the curve), each with `state_label`, `summary`, `plain` (the app's beginner sentence shown
until a brief exists), `brief` (the active one or null), `since` (null with `since_open` when the
state predates the app's data: say "since before <since_min>", never invent a start), metric texts and
`last_note_at`. The state is the app's, never yours: do not restate or dispute it. The owner reads
each card as one plain headline, a short why and two short lists, "Co sprzyja" and "Na co uważać".
Write a **macro brief note** (`segment` = its `note_key`, e.g. `macro_risk`) when the state changed
since its last macro note, its main drivers changed, a dated decisive event happened this week (a
central bank decision, an official data release that moved the regime's metric materially), or on the
first run for a card without a brief. Same note rules as segments (400 characters, kind `macro`,
`trend` or `news`, one brief note per key and ISO week, counted in the 6 segment notes per week,
relation `none`), and `details.brief` `{headline, why, supports, risks}`: `headline` the state in plain words
(`Trwa hossa na giełdach`, `Akcje są w korekcie, ale zyski spółek rosną`), `why` why the state holds
(at most 280 characters), `supports` and `risks` 0-3 items each (at most 90 characters): conditions
and facts that historically supported or weighed on such a market, named plainly (`Niskie stopy
sprzyjają`, `Wyceny są wysoko, więc rynek jest wrażliwy na złe wiadomości`), never your own view of
what will happen or what the owner should do. `why`, `supports` and `risks` may cite institutions'
published macro projections as estimates with who, how much and horizon (`MFW prognozuje wzrost PKB
USA o 2,1 % w 2027`, `Fed w projekcji (dot plot) zakłada stopy ok. 3,4 % na koniec 2026`, `projekcja
NBP: inflacja 2,5 % w 2027`; `references/sources.md` 5), never a forecast of an index or of
valuations (`S&P 500 wzrośnie do`, `wyceny spadną`). `expires_in_days: 60`. Official sources first
(Fed, BLS, US Treasury, ECB, NBP, IMF, OECD); you may name the portfolio's segments the mechanism touches in neutral words (`dotyczy:
złoto, rynki wschodzące`). A `missing` or `stale` regime gets no note.
