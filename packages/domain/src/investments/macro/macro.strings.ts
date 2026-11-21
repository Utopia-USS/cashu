/**
 * UI texts of the macro regime cards (`macro/regimes.py`, `macro/texts.py`), Polish and English.
 *
 * Keys are stable ids: a regime key (`risk`), `<regime>.<state>` for per-state texts, a camelCase id
 * for a metric label or a sentence part. The Polish text of a state label, a meaning and a metric
 * label is also the regime's identity (the MCP `market` allow-list, the summary vocabulary of the
 * privacy gate), so it must stay byte-equal to the Python source: `macro.vectors.test.ts` checks
 * every table here against the Python-generated vectors.
 */

export const regimeLabels = {
  risk: { pl: "Rynek akcji", en: "Stock market" },
  dollar: { pl: "Dolar", en: "Dollar" },
  em: { pl: "Rynki wschodzące", en: "Emerging markets" },
  commodities: { pl: "Surowce", en: "Commodities" },
  rates: { pl: "Obligacje i stopy", en: "Bonds and rates" },
} as const;

/** Machine state -> label per regime (`STATES` / `STATES_EN`). */
export const regimeStateLabels = {
  "risk.bear": { pl: "bessa", en: "bear market" },
  "risk.correction": { pl: "korekta", en: "correction" },
  "risk.bull": { pl: "hossa", en: "bull market" },
  "risk.weak": { pl: "słabość", en: "weakness" },
  "risk.flat": { pl: "bez trendu", en: "no trend" },
  "dollar.strong": { pl: "umacnia się", en: "strengthening" },
  "dollar.weak": { pl: "słabnie", en: "weakening" },
  "dollar.flat": { pl: "bez trendu", en: "no trend" },
  "em.leading": { pl: "silniejsze od świata", en: "stronger than the world" },
  "em.lagging": { pl: "słabsze od świata", en: "weaker than the world" },
  "em.inline": { pl: "podobnie jak świat", en: "in line" },
  "commodities.bull": { pl: "hossa surowcowa", en: "commodity bull market" },
  "commodities.bear": { pl: "bessa surowcowa", en: "commodity bear market" },
  "commodities.flat": { pl: "bez trendu", en: "no trend" },
  "rates.rising": { pl: "rentowności rosną", en: "yields rising" },
  "rates.falling": { pl: "rentowności spadają", en: "yields falling" },
  "rates.stable": { pl: "rentowności stabilne", en: "yields stable" },
} as const;

/** One factual sentence per state about the usual mechanism (`MEANINGS` / `MEANINGS_EN`). */
export const regimeMeanings = {
  "risk.bull": {
    pl: "Globalne akcje są powyżej rosnącej średniej z 200 sesji: trwały trend wzrostowy zwykle sprzyja spółkom wzrostowym i rynkom ryzykowniejszym.",
    en: "Global stocks are above a rising 200-session average: a lasting uptrend usually favors growth stocks and riskier markets.",
  },
  "risk.weak": {
    pl: "Globalne akcje są poniżej średniej z 200 sesji: słabszy trend zwykle ciąży spółkom wzrostowym i rynkom ryzykowniejszym.",
    en: "Global stocks are below their 200-session average: a weaker trend usually weighs on growth stocks and riskier markets.",
  },
  "risk.correction": {
    pl: "Globalne akcje są 10-20 % poniżej szczytu z ostatniego roku: spadek wycen zwykle ciąży nastrojom inwestorów i rynkom ryzykowniejszym.",
    en: "Global stocks are 10-20% below their peak of the last year: falling prices usually weigh on investor sentiment and riskier markets.",
  },
  "risk.bear": {
    pl: "Globalne akcje są co najmniej 20 % poniżej szczytu z ostatniego roku: bessa zwykle ciąży wszystkim aktywom ryzykownym i sprzyja bezpiecznym obligacjom.",
    en: "Global stocks are at least 20% below their peak of the last year: a bear market usually weighs on all risky assets and favors safe bonds.",
  },
  "risk.flat": {
    pl: "Globalne akcje są powyżej średniej z 200 sesji, ale ta średnia nie rośnie: rynek nie ma wyraźnego trendu.",
    en: "Global stocks are above their 200-session average, but the average is not rising: the market has no clear trend.",
  },
  "dollar.strong": {
    pl: "Umacniający się dolar podnosi wartość aktywów w USD liczoną w złotych i zwykle ciąży rynkom wschodzącym oraz surowcom wycenianym w dolarach.",
    en: "A strengthening dollar raises the value of USD assets in zloty and usually weighs on emerging markets and dollar-priced commodities.",
  },
  "dollar.weak": {
    pl: "Słabnący dolar obniża wartość aktywów w USD liczoną w złotych i zwykle sprzyja rynkom wschodzącym oraz surowcom wycenianym w dolarach.",
    en: "A weakening dollar lowers the value of USD assets in zloty and usually favors emerging markets and dollar-priced commodities.",
  },
  "dollar.flat": {
    pl: "Indeks dolara nie ma wyraźnego trendu: ani półroczna zmiana, ani średnia z 200 sesji nie wskazują jednego kierunku.",
    en: "The dollar index has no clear trend: neither the six-month change nor the 200-session average points one way.",
  },
  "em.leading": {
    pl: "Akcje rynków wschodzących radzą sobie od pół roku lepiej niż akcje globalne: taka przewaga zwykle idzie w parze ze słabszym dolarem i drożejącymi surowcami.",
    en: "Emerging market stocks have done better than global stocks for half a year: such a lead usually goes with a weaker dollar and rising commodity prices.",
  },
  "em.lagging": {
    pl: "Akcje rynków wschodzących radzą sobie od pół roku gorzej niż akcje globalne: taka słabość zwykle idzie w parze z silnym dolarem i taniejącymi surowcami.",
    en: "Emerging market stocks have done worse than global stocks for half a year: such weakness usually goes with a strong dollar and falling commodity prices.",
  },
  "em.inline": {
    pl: "Akcje rynków wschodzących radzą sobie od pół roku podobnie jak akcje globalne.",
    en: "Emerging market stocks have done about as well as global stocks for half a year.",
  },
  "commodities.bull": {
    pl: "Szeroki koszyk surowców jest powyżej średniej z 200 sesji i ponad 10 % wyżej niż przed rokiem: drożejące surowce zwykle sprzyjają spółkom surowcowym i ciążą obligacjom przez presję inflacyjną.",
    en: "A broad commodity basket is above its 200-session average and over 10% higher than a year ago: rising commodity prices usually favor commodity companies and weigh on bonds through inflation pressure.",
  },
  "commodities.bear": {
    pl: "Szeroki koszyk surowców jest poniżej średniej z 200 sesji i ponad 10 % niżej niż przed rokiem: taniejące surowce zwykle ciążą spółkom surowcowym i górniczym.",
    en: "A broad commodity basket is below its 200-session average and over 10% lower than a year ago: falling commodity prices usually weigh on commodity and mining companies.",
  },
  "commodities.flat": {
    pl: "Szeroki koszyk surowców nie ma wyraźnego trendu: to ani hossa, ani bessa surowcowa.",
    en: "A broad commodity basket has no clear trend: neither a commodity bull nor a bear market.",
  },
  "rates.rising": {
    pl: "Wyższe rentowności podnoszą koszt pieniądza: zwykle ciążą wycenom spółek wzrostowych i cenom obligacji długoterminowych.",
    en: "Higher yields raise the cost of money: they usually weigh on growth stock valuations and long-term bond prices.",
  },
  "rates.falling": {
    pl: "Niższe rentowności obniżają koszt pieniądza: zwykle sprzyjają wycenom spółek wzrostowych i cenom obligacji długoterminowych.",
    en: "Lower yields lower the cost of money: they usually favor growth stock valuations and long-term bond prices.",
  },
  "rates.stable": {
    pl: "Rentowność 10-letnich obligacji USA zmieniła się w 3 miesiące o mniej niż 0,40 pp: koszt pieniądza stoi w miejscu.",
    en: "The 10-year US Treasury yield moved less than 0.40 pp in 3 months: the cost of money is standing still.",
  },
} as const;

/**
 * Metric labels by stable id. The Polish label is the metric's identity (`METRIC_LABELS`: the MCP
 * `market` allow-list, the texts' metric lookups); the English one is display only.
 */
export const metricLabels = {
  acwiVsMa200: { pl: "ACWI wobec 200 sesji", en: "ACWI vs 200 sessions" },
  fromPeak: { pl: "od szczytu", en: "from the peak" },
  spxFromPeak: { pl: "S&P 500 od szczytu", en: "S&P 500 from the peak" },
  dxy: { pl: "DXY", en: "DXY" },
  dxy6m: { pl: "6 mies.", en: "6 mo." },
  usdpln6m: { pl: "USD/PLN 6 mies.", en: "USD/PLN 6 mo." },
  eemVsAcwi6m: { pl: "EEM wobec ACWI 6 mies.", en: "EEM vs ACWI 6 mo." },
  eem6m: { pl: "EEM 6 mies.", en: "EEM 6 mo." },
  dbc12m: { pl: "DBC 12 mies.", en: "DBC 12 mo." },
  dbcVsAcwi12m: { pl: "wobec ACWI 12 mies.", en: "vs ACWI 12 mo." },
  us10y: { pl: "USA 10 lat", en: "US 10-year" },
  us10y3mChange: { pl: "3 mies. zmiana", en: "3 mo. change" },
  curve10y3m: { pl: "krzywa 10l-3m", en: "curve 10y-3m" },
} as const;

/** Month names: genitive in Polish (after `od`), plain in English (`MONTHS_GENITIVE` / `MONTHS_EN`). */
export const monthNames = {
  january: { pl: "stycznia", en: "January" },
  february: { pl: "lutego", en: "February" },
  march: { pl: "marca", en: "March" },
  april: { pl: "kwietnia", en: "April" },
  may: { pl: "maja", en: "May" },
  june: { pl: "czerwca", en: "June" },
  july: { pl: "lipca", en: "July" },
  august: { pl: "sierpnia", en: "August" },
  september: { pl: "września", en: "September" },
  october: { pl: "października", en: "October" },
  november: { pl: "listopada", en: "November" },
  december: { pl: "grudnia", en: "December" },
} as const;

/** The card summary's opening per state (`_RISK_HEAD` ... / `_HEAD_EN`). */
export const summaryHeads = {
  "risk.bull": { pl: "Akcje na świecie rosną", en: "Global stocks rising" },
  "risk.flat": {
    pl: "Akcje na świecie bez wyraźnego trendu",
    en: "Global stocks without a clear trend",
  },
  "risk.weak": { pl: "Akcje na świecie słabną", en: "Global stocks weakening" },
  "risk.correction": { pl: "Akcje na świecie w korekcie", en: "Global stocks in a correction" },
  "risk.bear": { pl: "Akcje na świecie w bessie", en: "Global stocks in a bear market" },
  "dollar.strong": { pl: "Dolar umacnia się", en: "Dollar strengthening" },
  "dollar.weak": { pl: "Dolar słabnie", en: "Dollar weakening" },
  "dollar.flat": { pl: "Dolar bez wyraźnego trendu", en: "Dollar without a clear trend" },
  "em.leading": {
    pl: "Rynki wschodzące radzą sobie lepiej niż świat",
    en: "Emerging markets doing better than the world",
  },
  "em.lagging": {
    pl: "Rynki wschodzące radzą sobie gorzej niż świat",
    en: "Emerging markets doing worse than the world",
  },
  "em.inline": {
    pl: "Rynki wschodzące idą podobnie jak świat",
    en: "Emerging markets moving in line with the world",
  },
  "commodities.bull": { pl: "Surowce drożeją", en: "Commodity prices rising" },
  "commodities.bear": { pl: "Surowce tanieją", en: "Commodity prices falling" },
  "commodities.flat": {
    pl: "Surowce bez wyraźnego trendu",
    en: "Commodities without a clear trend",
  },
  "rates.rising": { pl: "Rentowności obligacji USA rosną", en: "US bond yields rising" },
  "rates.falling": { pl: "Rentowności obligacji USA spadają", en: "US bond yields falling" },
  "rates.stable": { pl: "Rentowności obligacji USA stabilne", en: "US bond yields stable" },
} as const;

/** What the cycle / indicator is: static, educational (`INTRO` / `INTRO_EN`). */
export const regimeIntros = {
  risk: {
    pl: "Rynek akcji przechodzi cykle: hossę (długie okresy wzrostów), korekty (spadki o 10-20 %) i bessy (spadki o co najmniej 20 % od szczytu). Hossy trwały zwykle kilka lat, bessy zwykle od kilku miesięcy do około półtora roku.",
    en: "The stock market goes through cycles: bull markets (long periods of gains), corrections (drops of 10-20%) and bear markets (drops of at least 20% from the peak). Bull markets usually lasted several years, bear markets usually from a few months to about a year and a half.",
  },
  dollar: {
    pl: "Dolar przez lata na przemian umacniał się i słabł wobec innych walut, a jedna taka faza trwała zwykle kilka lat. To główna waluta handlu i surowców, więc jego kurs zwykle szedł w parze z cenami surowców, wynikami rynków wschodzących i wartością zagranicznych aktywów w złotych.",
    en: "Over the years the dollar has alternately strengthened and weakened against other currencies, and one such phase usually lasted several years. It is the main currency of trade and commodities, so its exchange rate usually went together with commodity prices, emerging market results and the value of foreign assets in zloty.",
  },
  em: {
    pl: "Rynki wschodzące to akcje krajów rozwijających się, m.in. Chin, Indii, Tajwanu i Brazylii. Na przemian wyprzedzały rynki rozwinięte i zostawały za nimi, a takie okresy trwały zwykle kilka lat.",
    en: "Emerging markets are stocks of developing countries, including China, India, Taiwan and Brazil. They have alternately led and lagged developed markets, and such periods usually lasted several years.",
  },
  commodities: {
    pl: "Surowce (ropa, gaz, metale, płody rolne) mają własne, wieloletnie cykle drożenia i tanienia. Długą falę wzrostów nazywa się supercyklem: ostatni przypadł na pierwszą dekadę XXI wieku, gdy szybko rósł popyt z Chin.",
    en: "Commodities (oil, gas, metals, crops) have their own multi-year cycles of rising and falling prices. A long wave of gains is called a supercycle: the last one came in the first decade of the 21st century, when demand from China grew fast.",
  },
  rates: {
    pl: "Rentowność obligacji to roczny zysk z pożyczenia pieniędzy państwu; rentowność 10-letnich obligacji USA jest punktem odniesienia dla kosztu pieniądza na świecie. Krzywa rentowności porównuje obligacje długie z krótkimi: zwykle długie dają więcej, a gdy krótkie dawały więcej (krzywa odwrócona), w przeszłości często wyprzedzało to recesję w USA, choć nie zawsze.",
    en: "A bond yield is the yearly return on lending money to a government; the 10-year US Treasury yield is the benchmark for the cost of money worldwide. The yield curve compares long bonds with short ones: long ones usually yield more, and when short ones yielded more (an inverted curve), it often came before a US recession in the past, though not always.",
  },
} as const;

/** How the app measures it, the rule in plain words (`RULE` / `RULE_EN`). */
export const regimeRules = {
  risk: {
    pl: "Aplikacja patrzy na globalny ETF akcji ACWI: hossa, gdy kurs jest nad rosnącą średnią z 200 sesji; korekta przy spadku o 10-20 % od szczytu z ostatniego roku, bessa przy spadku o 20 % lub więcej.",
    en: "The app looks at the global stock ETF ACWI: a bull market when the price is above a rising 200-session average; a correction on a drop of 10-20% from the peak of the last year, a bear market on a drop of 20% or more.",
  },
  dollar: {
    pl: "Aplikacja patrzy na indeks dolara DXY (dolar wobec koszyka głównych walut): umacnia się, gdy indeks jest nad średnią z 200 sesji i zyskał w pół roku ponad 3 %; słabnie przy odwrotnym układzie.",
    en: "The app looks at the dollar index DXY (the dollar against a basket of major currencies): strengthening when the index is above its 200-session average and gained over 3% in six months; weakening in the opposite case.",
  },
  em: {
    pl: "Aplikacja porównuje ETF rynków wschodzących EEM z globalnym ETF akcji ACWI: gdy EEM wypadł w pół roku o ponad 5 % lepiej, rynki wschodzące są silniejsze od świata, gdy o ponad 5 % gorzej, słabsze.",
    en: "The app compares the emerging markets ETF EEM with the global stock ETF ACWI: when EEM did over 5% better in six months, emerging markets are stronger than the world, when over 5% worse, weaker.",
  },
  commodities: {
    pl: "Aplikacja patrzy na szeroki koszyk surowców, ETF DBC: hossa surowcowa, gdy kurs jest nad średnią z 200 sesji i ponad 10 % wyżej niż przed rokiem; bessa surowcowa przy odwrotnym układzie.",
    en: "The app looks at a broad commodity basket, the ETF DBC: a commodity bull market when the price is above its 200-session average and over 10% higher than a year ago; a commodity bear market in the opposite case.",
  },
  rates: {
    pl: "Aplikacja patrzy na zmianę rentowności 10-letnich obligacji USA w 3 miesiące: zmiana o co najmniej 0,40 pp w górę to rosnące rentowności, w dół spadające; krzywą liczy jako różnicę między obligacjami 10-letnimi a bonami 3-miesięcznymi.",
    en: "The app looks at the 3-month change of the 10-year US Treasury yield: a move of at least 0.40 pp up means rising yields, down falling ones; it measures the curve as the difference between 10-year bonds and 3-month bills.",
  },
} as const;

/** One beginner sentence per state (P9, `PLAIN` / `PLAIN_EN`): the card shows it until a brief exists. */
export const plainSentences = {
  "risk.bull": {
    pl: "Trwa hossa: akcje na świecie od dłuższego czasu drożeją.",
    en: "A bull market: stocks around the world have been rising for a while.",
  },
  "risk.flat": {
    pl: "Akcje na świecie stoją w miejscu, bez wyraźnego kierunku.",
    en: "Stocks around the world are standing still, with no clear direction.",
  },
  "risk.weak": {
    pl: "Akcje na świecie tracą siłę: ceny są niżej niż przez ostatnie miesiące.",
    en: "Stocks around the world are losing strength: prices are lower than in recent months.",
  },
  "risk.correction": {
    pl: "Akcje są w korekcie: spadły o 10-20 % od szczytu.",
    en: "Stocks are in a correction: down 10-20% from the peak.",
  },
  "risk.bear": {
    pl: "Trwa bessa: akcje spadły o ponad 20 % od szczytu.",
    en: "A bear market: stocks are down more than 20% from the peak.",
  },
  "dollar.strong": { pl: "Dolar się umacnia.", en: "The dollar is strengthening." },
  "dollar.weak": { pl: "Dolar słabnie.", en: "The dollar is weakening." },
  "dollar.flat": {
    pl: "Kurs dolara stoi w miejscu.",
    en: "The dollar exchange rate is standing still.",
  },
  "em.leading": {
    pl: "Akcje krajów rozwijających się radzą sobie lepiej niż reszta świata.",
    en: "Stocks of developing countries are doing better than the rest of the world.",
  },
  "em.lagging": {
    pl: "Akcje krajów rozwijających się radzą sobie gorzej niż reszta świata.",
    en: "Stocks of developing countries are doing worse than the rest of the world.",
  },
  "em.inline": {
    pl: "Akcje krajów rozwijających się idą podobnie jak reszta świata.",
    en: "Stocks of developing countries are moving like the rest of the world.",
  },
  "commodities.bull": {
    pl: "Surowce drożeją: koszyk ropy, metali i płodów rolnych jest wyraźnie droższy.",
    en: "Commodities are getting pricier: a basket of oil, metals and crops costs clearly more.",
  },
  "commodities.bear": {
    pl: "Surowce tanieją: koszyk ropy, metali i płodów rolnych jest wyraźnie tańszy.",
    en: "Commodities are getting cheaper: a basket of oil, metals and crops costs clearly less.",
  },
  "commodities.flat": {
    pl: "Ceny surowców stoją w miejscu.",
    en: "Commodity prices are standing still.",
  },
  "rates.rising": {
    pl: "Oprocentowanie obligacji w USA rośnie, więc pożyczanie pieniędzy drożeje.",
    en: "US bond yields are rising, so borrowing money is getting more expensive.",
  },
  "rates.falling": {
    pl: "Oprocentowanie obligacji w USA spada, więc pożyczanie pieniędzy tanieje.",
    en: "US bond yields are falling, so borrowing money is getting cheaper.",
  },
  "rates.stable": {
    pl: "Oprocentowanie obligacji w USA stoi w miejscu.",
    en: "US bond yields are standing still.",
  },
} as const;

/** Fixed texts and sentence parts of the cards (functions take the already formatted parts). */
export const macroStrings = {
  unknownLabel: { pl: "brak danych", en: "no data" },
  /** The inversion modifier of a state label (the UI splits `state_label` on ` · `). */
  invertedSuffix: { pl: " · krzywa odwrócona", en: " · inverted curve" },
  unknownMeaning: {
    pl: "Za mało aktualnych notowań, by ustalić stan.",
    en: "Too few current prices to determine the state.",
  },
  invertedMeaning: {
    pl: "Krzywa jest odwrócona: bony 3-miesięczne dają więcej niż obligacje 10-letnie, co zwykle ciąży marżom banków i akcji kredytowej.",
    en: "The curve is inverted: 3-month bills yield more than 10-year bonds, which usually weighs on bank margins and lending.",
  },
  /** The percent sign after a number (`4,1 %` / `4.1%`). */
  percent: { pl: " %", en: "%" },
  unknownSummary: {
    pl: "Za mało aktualnych notowań, by opisać ten rynek.",
    en: "Too few current prices to describe this market.",
  },
  invertedSentence: {
    pl: "Krzywa odwrócona: bony 3-miesięczne dają więcej niż 10-letnie.",
    en: "Inverted curve: 3-month bills yield more than 10-year bonds.",
  },
  plainInverted: {
    pl: "Krótkie obligacje płacą więcej niż długie, co w przeszłości często było sygnałem ostrzegawczym.",
    en: "Short bonds pay more than long ones, which in the past was often a warning sign.",
  },
  plainUnknown: {
    pl: "Za mało danych, by opisać ten rynek.",
    en: "Too little data to describe this market.",
  },
  since: { pl: (month: string) => `od ${month}`, en: (month: string) => `since ${month}` },
  sinceAtLeast: {
    pl: (month: string) => `co najmniej od ${month}`,
    en: (month: string) => `since at least ${month}`,
  },
  versusSame: {
    pl: (other: string) => `tyle samo co ${other}`,
    en: (other: string) => `the same as ${other}`,
  },
  versusMore: {
    pl: (pp: string, other: string) => `o ${pp} więcej niż ${other}`,
    en: (pp: string, other: string) => `${pp} more than ${other}`,
  },
  versusLess: {
    pl: (pp: string, other: string) => `o ${pp} mniej niż ${other}`,
    en: (pp: string, other: string) => `${pp} less than ${other}`,
  },
  /** What emerging markets are compared with. */
  globalStocksEm: { pl: "akcje globalne", en: "global stocks" },
  /** What commodities are compared with. */
  globalStocksCommodities: { pl: "akcje na świecie", en: "global stocks" },
  atYearlyPeak: { pl: "na rocznym szczycie", en: "at the yearly peak" },
  belowYearlyPeak: {
    pl: (pct: string) => `${pct} pod rocznym szczytem`,
    en: (pct: string) => `${pct} below the yearly peak`,
  },
  riskPeakDetail: { pl: (peak: string) => `są ${peak}`, en: (peak: string) => peak },
  riskWeakDetail: { pl: "są pod średnią z 200 sesji", en: "below the 200-session average" },
  riskWeakPeakDetail: {
    pl: (peak: string) => `są pod średnią z 200 sesji i ${peak}`,
    en: (peak: string) => `below the 200-session average and ${peak}`,
  },
  currencyBarelyChanged: {
    pl: "kursy walut prawie nie zmieniły wyniku portfela",
    en: "currency moves barely changed the portfolio's result",
  },
  currencyAdded: {
    pl: (pp: string) => `kursy walut dodały portfelowi ${pp}`,
    en: (pp: string) => `currency moves added ${pp} to the portfolio`,
  },
  currencyTook: {
    pl: (pp: string) => `kursy walut odjęły portfelowi ${pp}`,
    en: (pp: string) => `currency moves took ${pp} off the portfolio`,
  },
  weekEffect: {
    pl: (effect: string) => `W tym tygodniu ${effect}.`,
    en: (effect: string) => `This week ${effect}.`,
  },
  weekMove: {
    pl: (move: string) => `W tym tygodniu USD/PLN ${move}.`,
    en: (move: string) => `This week USD/PLN ${move}.`,
  },
  weekMoveAndEffect: {
    pl: (move: string, effect: string) => `W tym tygodniu USD/PLN ${move}, a ${effect}.`,
    en: (move: string, effect: string) => `This week USD/PLN ${move}, and ${effect}.`,
  },
  dollarSixMonths: {
    pl: (pct: string) => `indeks dolara ${pct} w pół roku`,
    en: (pct: string) => `dollar index ${pct} in six months`,
  },
  emSixMonths: {
    pl: (pct: string) => `w pół roku ${pct}`,
    en: (pct: string) => `${pct} in six months`,
  },
  commoditiesYear: {
    pl: (pct: string) => `${pct} w rok`,
    en: (pct: string) => `${pct} in a year`,
  },
  ratesLevel: {
    pl: (level: string) => `10-letnie ${level} %`,
    en: (level: string) => `10-year ${level}%`,
  },
  ratesChange: {
    pl: (change: string) => `${change} pp w 3 miesiące`,
    en: (change: string) => `${change} pp in 3 months`,
  },
  explainNow: {
    pl: (state: string, meaning: string) => `Teraz: ${state}. ${meaning}`,
    en: (state: string, meaning: string) => `Now: ${state}. ${meaning}`,
  },
} as const;
