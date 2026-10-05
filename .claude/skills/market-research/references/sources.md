# Source rules

Every note stands on dated, public sources you actually opened. This file says which sources count,
in what order, and what each kind of source may and may not support. Rubrics for polarity, thesis
relation and strength: `rubrics.md`. Writing the note: `notes.md`.

## Rules for every source

- **Seen, dated, attributable.** A source enters `sources` only if you opened the page (or the search
  result itself shows the fact, the publisher and the date) and it has a publication date or a dated
  data point. No date: find a dated alternative or drop the fact. Never construct, guess or shorten a
  URL; copy the one you opened.
- **Window.** Weekly run: facts published since the instrument's or theme's last research date from
  `research_context`; never researched: the last 30 days. Older facts may appear in the summary as
  background, never as the fact the note is about.
- **Primary first.** Look for the primary source before the press, and cite it when you find it.
  Strength 3 and `invalidates` need a primary source (`rubrics.md`).
- **Public pages only.** Never log in, never use the user's browser, cookies or signed-in sessions,
  never use archive or cache mirrors, reader-mode tricks, alternative front-ends, scripts or any other
  way past a paywall, CAPTCHA, JavaScript challenge, "verify you are human" page or rate limit. A
  blocked or paywalled page is skipped: use what is visible without bypassing (headline, lead) only if
  it states the fact, otherwise look for the primary source or another free outlet. Count the skip in
  the run's `skipped` counter and list it in the working file. A site that blocked you once is not
  retried in the same run.
- **Your own words.** Summarize; quote at most a short phrase in quotation marks. Never paste article
  text, tables or posts.
- **Search queries carry public identifiers only:** ticker, ISIN, company, fund, sector or topic. Never
  weights, amounts, account labels, the profile name, or a list of the profile's holdings in one query.

## Never use as content

- Analyst ratings, brokerage recommendations (`rekomendacje domów maklerskich`), price targets
  (`cena docelowa`), "fair value" estimates, analyst consensus forecasts, model portfolios.
- Technical-analysis forecasts (targets, "breakout", support and resistance levels).
- Sponsored or promotional content, paid stock promotion, content farms, anonymous "insider" claims.
- If an article mixes facts and ratings, take only the facts and never mention the rating or target.

## 1. News and company reports (kinds `news`, `earnings`)

Order of preference:

1. **Primary.** The issuer's own disclosures: ESPI / EBI current and periodic reports (GPW,
   NewConnect), SEC EDGAR filings (8-K, 10-Q, 10-K, 6-K, 20-F), exchange notices, the issuer's
   investor-relations releases and results presentations, general meeting resolutions, dividend
   announcements. For funds and ETFs: the issuer's notices and factsheets (index change, fee change,
   merger or closure, replication or domicile change, distribution policy). Official bodies: KNF,
   ESMA, SEC, UOKiK, the European Commission, courts' and regulators' published decisions.
2. **Reputable press** with editorial standards (for example PAP Biznes, Reuters, Bloomberg, Financial
   Times, Wall Street Journal, Rzeczpospolita, Parkiet, Puls Biznesu, Bankier.pl news): for context and
   when the primary source is not public. Cross-check material claims with a second independent
   outlet.
3. **Aggregators and blogs:** only to find the primary source; never the only source of a note with
   strength 2 or more.

What to report from results (`earnings`): the period, the metric the thesis rests on, the change
year on year (and quarter on quarter where it matters), changes to the company's own guidance, the
next dated events (results calendar, general meeting, dividend dates). Compare with the prior period
and the company's own guidance, never with analyst consensus.

What to skip: daily price moves without a stated cause, "stock X fell 3% today" pieces, repeated
coverage of an event you already noted (`notes.md`, duplicates).

## 2. Community sentiment (kind `community`)

Where: public pages of Reddit (investing subreddits, Polish and international), X (public posts and
cashtags), investor forums (for example forum Bankier.pl, StockWatch.pl forum, Stocktwits). Only what
loads without logging in; X and some forums often require a login: then skip them.

What you record, and nothing else:

- **Scale:** roughly how many posts or threads in the window, compared with the usual level for that
  instrument or topic (`ok. 30 wpisów w tygodniu, zwykle kilka`).
- **Direction:** the rough share of positive, negative and mixed posts (`przewaga negatywnych, ok. 60 %`).
- **Topics:** the two or three things people discuss.

Always:

- The note is kind `community`, which the app shows as `społeczność · szum`; the summary also names
  the venues, the sample size and `szum` with `mała skala` or `duża skala`.
- Strength 1 by default; 2 only when the scale is far above the usual level across several venues;
  never 3. Expiry 15 days (sentiment ages fast).
- Never `invalidates`. `supports` / `weakens` only when the thesis itself is about sentiment (entry
  type `sentiment_correction`, or the thesis text names sentiment); otherwise `neutral` (thesis exists)
  or `none`.
- A rumour of a fact (takeover, fraud, insolvency, management change) found in the community is not a
  fact. Verify it in a primary source; if verified, write the fact as its own `news` note; if not,
  the community note says `niepotwierdzone`.
- No usernames or handles, no quotes beyond a few words, no screenshots, nothing about any person.
  Link the thread or the listing page you read, never a user profile.
- Skip community for broad index ETFs, bonds and cash: the signal is meaningless there.

## 3. Trend data (kind `trend`)

Every trend note states **the measure, the source, the period and the comparison base**, and it
describes the past only.

- **Sector and regional ETF flows:** from the fund issuer or a tracker that publishes free data. State
  the fund or sector, the period (`4 tyg. do 2.10`), the direction and size (in the fund's currency or
  as % of assets), and the source with its date.
- **Relative strength:** the change of the instrument or sector ETF minus the change of a stated
  benchmark (the strategy's benchmark when it fits) over a stated window, from dated closes: the
  app's own data through MCP (`watchlist`, `positions`, `research_context`) or a public price page that
  loads without bot protection. Write it as `siła relatywna vs ACWI +6 pp w 8 tyg. (do 2.10)`.
- **Search trends:** Google Trends or a similar public tool: the term, region, period and change vs the
  previous period. It measures interest, not the direction of opinion; say so when it matters.
- **Moving averages and drawdowns** only as measured facts when the strategy's own criteria use them
  (`powyżej SMA 200 od 6 tyg.`); otherwise leave technical measures to the app's rules and alerts.
- Never extrapolate: no `trend będzie trwał`, `może wzrosnąć do`, `kierunek na`.
- Strength at most 2.

## 4. Macro and sector themes (kind `macro`, or `trend` for theme flows)

- Official sources first: central bank decisions and statements (NBP, ECB, Fed), statistics releases
  (GUS, Eurostat, BLS), government and regulator decisions, published laws and tax changes. Dated.
- A theme note carries the `theme`, no instrument, `thesis_relation: none` (the app refuses anything
  else there), and names the affected holdings in the summary by symbol. A relation is always about one
  thesis: when the theme fact bears on a specific thesis, write the note for that instrument with the
  theme set too.
- Strength 3 only for an official decision that directly hits held positions (an unexpected rate move,
  a sector tax, a ban); everything else 1-2.

## Coverage per instrument type

| instrument | per-instrument sources | community | trend data |
|---|---|---|---|
| single stock | issuer disclosures, press | yes (flagged) | sector flows, relative strength |
| sector or thematic ETF | issuer notices | rarely | flows, relative strength |
| broad index ETF (world, S&P 500, WIG20 ...) | issuer notices only | no | cover through macro themes |
| bonds, treasury bonds, cash | issuer or state notices only | no | cover through macro themes (rates, inflation) |
| crypto | project and exchange announcements, regulators | yes (flagged, extra noisy) | flows of listed products, relative strength |
