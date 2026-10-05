# Rubrics: kind, polarity, thesis relation, strength

Three independent axes per note. Decide them in this order: kind (what the source is), polarity
(which way the fact points for the instrument or theme), thesis relation (what it means for the
owner's own thesis). Then strength. Polarity colours the dot in the app; the relation colours the chip
and drives the thesis health; strength 3 and `invalidates` create signals.

## Kind

| kind | use for | app label |
|---|---|---|
| `news` | company or fund events: contracts, M&A, management, legal and regulatory decisions about the issuer, product launches and delays, issuer notices of a fund | `wiadomość` |
| `earnings` | periodic results and the company's own guidance | `wyniki` |
| `community` | Reddit, X, investor forums: scale and direction only (`sources.md` 2) | `społeczność · szum` |
| `trend` | ETF flows, relative strength, search trends (`sources.md` 3) | `trend` |
| `macro` | rates, inflation, FX, policy, laws and regulation affecting a market or sector | `makro` |
| `candidate` | a new instrument matching the strategy's entry criteria (`candidates.md`) | `kandydat` |

## Polarity (direction of the fact)

- `positive`: good for the issuer, fund or sector as the market would read it (results above the prior
  period, a contract won, inflows, a favourable ruling).
- `negative`: bad for it (guidance cut, delay, outflows, a fine, a downgrade of the company's own outlook).
- `neutral`: mixed or informational (a scheduled event confirmed, results flat, a candidate match).

Polarity is not the relation: a negative fact can leave the thesis untouched (`neutral` relation), and
a neutral results note can weaken a thesis whose premise was growth.

## Thesis relation (tied to the thesis record)

Read the thesis first (`research_context`, or `theses(instrument)`): entry type, thesis, invalidation
condition, exit plan, size plan. Then go down this list and take the first answer that fits.

1. **`invalidates`** (`podważa tezę`): a verified fact meets the written **invalidation condition**,
   literally or in substance. All of these must hold:
   - a primary source (or two independent reputable outlets when the primary is not public), dated in
     the window;
   - the fact itself meets the condition, not an opinion or an interpretation of it;
   - the summary quotes the condition briefly (`Warunek unieważnienia: „...”`) and states the fact that
     meets it;
   - never from community or trend data alone, never from a price move alone: price and technical
     conditions (`spadek poniżej X`, `poniżej SMA 200`) are measured by the app's rules and alerts on
     hard data, not by research;
   - `thesis_field` = `invalidation`.
2. **`weakens`** (`osłabia tezę`): a verified fact
   - moves toward the invalidation condition without meeting it; or
   - removes or undermines a premise of the thesis text (the "why"); or
   - pushes the catalyst the **exit plan** waits for later, or makes it less likely (the exit plan says
     "po premierze" and the premiere slips by two quarters); or
   - for a `trend` entry: a sustained reversal of the trend the thesis rests on (several weeks of
     flows or relative strength, not one week).
   `thesis_field` = the field it touches (`thesis`, `invalidation`, `exit_plan`, `size_plan`, or
   `entry_type` when the kind of entry no longer describes the situation).
3. **`supports`** (`wzmacnia tezę`): a verified fact confirms a premise of the thesis (a milestone on
   time, the driver visible in results), moves away from the invalidation condition, or meets a
   fact-based condition of the exit plan (the awaited catalyst happened). In the last case say in the
   summary which exit-plan condition the fact meets, and nothing about what the owner should do.
4. **`neutral`** (`nie dotyka tezy`): a thesis exists, the fact is about the instrument, but it does not
   bear on the thesis, its invalidation or its exit plan.
5. **`none`** (`bez tezy`): there is no thesis record for the instrument (a held position without a
   thesis, a watched instrument without a draft thesis), a candidate, or a pure theme note.

Leave `thesis_field` empty for `neutral` and `none`.

Entry-type hints:

- `trend`: premises are about a persisting trend (demand, flows, relative strength). Trend data can
  support or weaken; a single week never weakens.
- `sentiment_correction`: the premise is that the price fell for sentiment reasons while the business
  holds. New fundamental damage (results confirming the bad news, a guidance cut, a balance-sheet
  problem) weakens or, per the condition, invalidates. Sentiment calming down supports; community
  notes may carry `supports` / `weakens` here (strength at most 2).
- `special_situation`: the premise is a dated event (tender offer, merger, spin-off, restructuring, a
  ruling). Progress on schedule supports; a delay, an obstacle or changed terms weaken; the event being
  cancelled usually meets the invalidation condition.

When in doubt between two relations, take the milder one (`weakens` over `invalidates`, `neutral`
over `supports` / `weakens`) and say in the summary what would settle it.

## Strength (1-3)

| strength | app | meaning | evidence needed |
|---|---|---|---|
| 1 | `siła 1 z 3` (słaba) | incremental, small or early; any community note by default | one reputable source |
| 2 | `siła 2 z 3` (umiarkowana) | material for the instrument or theme, not decisive | a primary source, or two independent reputable outlets |
| 3 | `siła 3 z 3` (silna) | decisive for a thesis premise, the invalidation condition or the exit plan; or a major event (M&A, tender offer, delisting, insolvency, guidance withdrawn, index exclusion, fund merger or closure, an official decision that directly hits held positions) | a primary source, always |

Caps per kind: `community` 2 (default 1), `trend` 2, `candidate` 2, `macro` 3 only with an official
source and a direct effect on held positions. `news` and `earnings` up to 3.

## What a note sets off in the app

- `invalidates` creates a research signal with severity **action** (an immediate notification when the
  strategy notifies on `action`).
- strength 3 creates a research signal with severity **info** (weekly digest and the Sygnały list).
- Signals are deduplicated per instrument or theme and week; dismissing the note resolves its signal.

Checklist before writing `invalidates` or strength 3:

1. The primary source is open in front of you and dated in the window.
2. The fact, not an interpretation, meets the criterion; the summary quotes the thesis field it meets.
3. No existing note this week already covers it (`research_notes`).
4. Title and summary are neutral: no recommendation, no forecast.
5. Any doubt left: write `weakens` and / or strength 2 instead.
