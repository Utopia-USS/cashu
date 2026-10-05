# Candidates from the strategy's entry criteria

A candidate is an instrument the profile neither holds nor watches that meets the entry criteria the
owner wrote into their strategy. It is a measured match, never a suggestion to buy: a candidate note
has no price, no target, no size and no "okazja". The owner decides in the app (`Obserwuj` adds it to
the watchlist and creates a draft thesis so research keeps tracking it; `Odrzuć` starts a 90-day
cooldown).

## Where the criteria come from

Only from `research_context` (`strategy`: its state and version, `candidate_criteria`):

- **Numeric thresholds** = `strategy.candidate_criteria`, the `watchlist.criteria` of the active
  `strategy.yaml` (free keys; common ones: `max_pe`, `min_pe`, `max_pb`, `min_dividend_yield`,
  `min_market_cap_pln`, `min_roe`, `max_debt_to_equity`; an owner may also write entry-type keys such as
  a minimum drawdown from the 52-week high or a number of weeks of inflows). A `max_*` key is met when
  the value is at or below it, `min_*` at or above; for any other key, read its meaning from the name
  and say in the criterion text how you read it.
- **Entry types** (`trend` = `trend`, `sentiment_correction` = `korekta sentymentu`,
  `special_situation` = `sytuacja specjalna`): the candidate's `details.entry_type`, chosen by which
  description below the facts fit. A descriptive part of an entry type (for example "the business
  holds" for a sentiment correction) is listed as a criterion with `threshold: null`.
- **Scope limits** the owner wrote into the strategy (allowed asset classes, markets, buckets, size
  filters, what it avoids) are known only when the user tells you in an interactive session; in an
  unattended run use the buckets and asset classes the profile already holds as the boundary.

Never invent a threshold, never loosen one, never fill a gap with a "typical" value. No approved
strategy (`strategy.state`) or an empty `candidate_criteria`: write no candidates
(`candidates_screened: 0` in the run counts) and mention in the final summary that criteria can be
added with `/investments-setup` (keys under `watchlist.criteria` in the strategy). Candidates never
become signals.

## What to measure per entry type (thresholds always from the strategy)

| entry type | facts that typically measure it | sources |
|---|---|---|
| `trend` | inflows into the sector or fund over N weeks, relative strength vs the strategy's benchmark over the window, a long moving average if the strategy uses one, a demand driver in data | issuer flow data, price data (`sources.md` 3), official statistics |
| `sentiment_correction` | drawdown from the 52-week high beyond the threshold; the cause is news flow or sentiment, while the business holds (results and the company's guidance stable, no balance-sheet event); sentiment negative (community flagged as noise) | price data, issuer reports, press, community |
| `special_situation` | a dated, verifiable event with a timeline: tender offer, merger, spin-off, strategic review, restructuring, index inclusion | primary disclosures only |

Each numeric value needs a dated source. A value you cannot verify from a public source is
`met: false` with the text `brak danych`.

## Exclusions (check before proposing)

- held positions and watched instruments (`research_context`);
- a candidate the owner dismissed within the last 90 days (its cooldown; `research_notes` with
  dismissed notes, or the tool refuses it);
- a candidate note for the same instrument in the last 30 days that is still active;
- outside the strategy's allowed asset classes, markets or buckets, or on its avoid list;
- not listed on a regulated market or too illiquid to price daily;
- anything that is "hot" only in the community.

Propose only when **every numeric threshold is met and verified**; descriptive criteria may be listed
as not met. At most 3 new candidates per weekly run; prefer the ones that fit a bucket of the strategy.

## The note

| field | value |
|---|---|
| `kind` | `candidate` |
| `candidate` | `{"symbol_or_isin": "XYZ.WA", "name": "Przykład SA", "exchange": "GPW", "currency": "PLN"}`: ticker with its market (`XYZ.WA`, `ABC.DE`, `DEF.US`) or ISIN; the app keys the 90-day cooldown on the upper-case ticker or ISIN, so use one spelling consistently (ISIN when you have it) |
| `polarity` | `neutral` (a match against criteria, not a direction) |
| `strength` | 1: all thresholds met, one value from a secondary source; 2: all met and verified from primary or official data. Never 3 (candidates live in `Kandydaci`, they do not need a signal) |
| `thesis_relation` | `none` |
| `details` | structured criteria, below |
| `theme` | the note's `theme` field: the theme it came from, when there is one |
| `title` | `<Name>: <what matches> (<entry type in Polish>)` |
| `summary` | the facts behind each criterion with dates, the context (theme, bucket), what is unknown |

`details` (the app renders one line per criterion: `✓` met, `·` not met, threshold in brackets).
Allowed keys: `entry_type` (required), `criteria` (required, at most 12, each `{text, met, threshold}`,
text at most 160 characters, threshold at most 60 or null), `criteria_version` (the strategy version,
integer), `bucket` (at most 40 characters), `context` (one line, at most 200 characters):

```json
{
  "entry_type": "sentiment_correction",
  "criteria": [
    {"text": "-31 % od szczytu 52 tyg.", "met": true, "threshold": "-25 %"},
    {"text": "przychody stabilne 4 kwartały", "met": true, "threshold": null},
    {"text": "C/Z 14,2", "met": true, "threshold": "max_pe 20"},
    {"text": "stopa dywidendy: brak danych", "met": false, "threshold": "min_dividend_yield 3 %"}
  ],
  "bucket": "Akcje PL",
  "criteria_version": 7,
  "context": "sentyment społeczności negatywny (szum), wiadomości neutralne"
}
```

Example (invented):

```json
{
  "kind": "candidate",
  "candidate": {"symbol_or_isin": "XYZ.WA", "name": "Przykład SA", "exchange": "GPW", "currency": "PLN"},
  "polarity": "neutral",
  "strength": 2,
  "thesis_relation": "none",
  "title": "Przykład SA: -31 % od szczytu przy stabilnych przychodach (korekta sentymentu)",
  "summary": "Kurs 30.09 o 31 % poniżej szczytu z 52 tygodni (próg strategii: -25 %). Raport za II kwartał (14.08): przychody +2 % r/r, czwarty kwartał bez spadku; spółka podtrzymała prognozę roczną. Spadek nastąpił po informacji o odejściu członka zarządu (komunikat 2.09).\n\nPoza portfelem, pasuje do koszyka Akcje PL. Stopa dywidendy niepotwierdzona w publicznym źródle.",
  "sources": [
    {"title": "Raport okresowy za II kwartał 2026", "url": "https://...", "publisher": "Przykład SA (ESPI)", "published_at": "2026-08-14"},
    {"title": "Notowania XYZ", "url": "https://...", "publisher": "stooq", "published_at": "2026-09-30"}
  ],
  "details": {"entry_type": "sentiment_correction", "criteria": ["..."]}
}
```

## Watchlist

Do not call `add_to_watchlist` in the unattended weekly routine: the owner accepts candidates with
`Obserwuj`, which also creates the draft thesis that research then tracks. On demand, add an
instrument only when the user explicitly asks in this session; pass `note` = `kandydat z researchu
<d.m>: <title>` (the row is badged `A agent`).
