// Texts of the v2 investments logic (src/modules/investments/v2/logic.ts): signal and alert copy, hints,
// recommendation labels, instrument facts. See src/i18n.ts.
import { catalog, enCount, plCount } from "../../../i18n.ts";

type Days = number | null;
/** A rule window in words: 250+ sessions read as 52 weeks. */
const plWin = (d: Days) => (d == null ? "" : d >= 250 ? "52 tyg." : `${d} sesji`);
const enWin = (d: Days) => (d == null ? "" : d >= 250 ? "52 weeks" : `${d} sessions`);
/** The window as an adjective before "high" / "low": "52-week", "30-session". */
const enWinAdj = (d: Days) => (d == null ? "" : d >= 250 ? "52-week " : `${d}-session `);

/** Expression bucket functions over a non-generic bucket, shown as a phrase instead of the call. */
export const BUCKET_FN = catalog({
  bucket_weight: { pl: "waga koszyka", en: "bucket weight" },
  bucket_target: { pl: "cel koszyka", en: "bucket target" },
  bucket_drift_pp: { pl: "dryf koszyka", en: "bucket drift" },
  bucket_value: { pl: "wartość koszyka", en: "bucket value" },
});

/** Rule kinds (a rule's strategy id never reaches the UI). */
export const RULE_KIND = catalog({
  drawdown_from_high: { pl: "transza spadkowa", en: "drawdown tranche" },
  gain_from_cost: { pl: "zysk od kosztu", en: "gain vs cost" },
  loss_from_cost: { pl: "strata od kosztu", en: "loss vs cost" },
  allocation_drift: { pl: "dryf alokacji", en: "allocation drift" },
  position_concentration: { pl: "koncentracja", en: "concentration" },
  contribution_gap: { pl: "brak wpłaty", en: "missed contribution" },
  cash_level: { pl: "poziom gotówki", en: "cash level" },
  tagged_weight: { pl: "udział tagów", en: "tag weight" },
  custom: { pl: "reguła własna", en: "custom rule" },
  plan: { pl: "Rekomendacja", en: "Recommendation" },
});

/** The signal state glyph's title. */
export const STATE = catalog({
  positive: { pl: "szansa", en: "opportunity" },
  negative: { pl: "ryzyko", en: "risk" },
  neutral: { pl: "sygnał", en: "signal" },
  mixed: { pl: "szansa i ryzyko", en: "opportunity and risk" },
});

/** Alert kinds. */
export const ALERT_KIND = catalog({
  price_above: { pl: "Cena powyżej", en: "Price above" },
  price_below: { pl: "Cena poniżej", en: "Price below" },
  change_pct: { pl: "Zmiana % w oknie", en: "Change % in a window" },
  drawdown_from_high: { pl: "Spadek od szczytu", en: "Drop from the high" },
  new_high: { pl: "Nowy szczyt", en: "New high" },
  sma_cross: { pl: "Przecięcie SMA", en: "SMA cross" },
  weight_above: { pl: "Waga powyżej", en: "Weight above" },
  weight_below: { pl: "Waga poniżej", en: "Weight below" },
  custom: { pl: "Własne wyrażenie", en: "Custom expression" },
  range_breakout: { pl: "Wybicie z konsolidacji", en: "Range breakout" },
  volume_spike: { pl: "Skok wolumenu", en: "Volume spike" },
});

/** A breakout's direction. */
export const DIR_WORD = catalog({
  up: { pl: "w górę", en: "up" },
  down: { pl: "w dół", en: "down" },
  any: { pl: "w którąkolwiek stronę", en: "either way" },
});

/** Model recommendation labels for a held instrument. */
export const PLAN_HELD_L = catalog({
  buy_asap: { pl: "dokup asap", en: "buy more asap" },
  buy: { pl: "dokup", en: "buy more" },
  hold: { pl: "trzymaj", en: "hold" },
  reduce: { pl: "redukuj", en: "reduce" },
  exit_asap: { pl: "pozbądź się asap", en: "exit asap" },
});
/** ... and for a watched one. */
export const PLAN_WATCHED_L = catalog({
  buy_asap: { pl: "kup asap", en: "buy asap" },
  buy: { pl: "kup", en: "buy" },
  hold: { pl: "czekam", en: "wait" },
});

/** The locative after "przy tezie" (en: the adjective before "thesis"). */
export const HEALTH_LOC_L = catalog({
  weak: { pl: "osłabionej", en: "weakened" },
  weakened: { pl: "osłabionej", en: "weakened" },
  inv: { pl: "podważonej", en: "invalidated" },
  invalidated: { pl: "podważonej", en: "invalidated" },
});

/** Short words for the P3 reason codes. */
export const FRESH_REASON = catalog({
  note_invalidates: { pl: "notatka podważa tezę", en: "a note invalidates the thesis" },
  thesis_invalidated: { pl: "teza podważona", en: "thesis invalidated" },
  fulfilled_buy: { pl: "teza spełniona", en: "thesis fulfilled" },
  note_after: { pl: "nowe notatki", en: "new notes" },
  thesis_changed: { pl: "teza zmieniona", en: "thesis changed" },
  rule_fired: { pl: "reguła strategii", en: "strategy rule" },
  alert_triggered: { pl: "alert", en: "alert" },
  age: { pl: "starsza niż 30 dni", en: "older than 30 days" },
});

export const FRESH = catalog({
  maybe: { pl: "może być nieaktualna", en: "may be outdated" },
  out: { pl: "nieaktualna", en: "outdated" },
});

/** Instrument status words (never the backend's raw status). */
export const INST_STATUS_L = catalog({
  frozen: { pl: "zamrożony", en: "frozen" },
  delisted: { pl: "wycofany z giełdy", en: "delisted" },
  inactive: { pl: "nieaktywny", en: "inactive" },
});

/** The timeline's head of a closed signal by polarity. */
export const STATE_HEAD_L = catalog({
  positive: { pl: "Szansa", en: "Opportunity" },
  negative: { pl: "Ryzyko", en: "Risk" },
  neutral: { pl: "Sygnał", en: "Signal" },
});

const REL_VERB_PL: Record<string, [string, string, string]> = {
  invalidates: ["podważa", "podważają", "tezę"], weakens: ["osłabia", "osłabiają", "tezę"], fulfills: ["spełnia", "spełniają", "tezę"],
  supports: ["wzmacnia", "wzmacniają", "tezę"],
};
const REL_VERB_EN: Record<string, [string, string]> = {
  invalidates: ["invalidates", "invalidate"], weakens: ["weakens", "weaken"], fulfills: ["fulfills", "fulfill"], supports: ["supports", "support"],
};

export const S = catalog({
  moveWeek: { pl: "tydz.", en: "wk" },
  moveDay: { pl: "1 d.", en: "1d" },
  rule: { pl: "reguła", en: "rule" },
  alert: { pl: "alert", en: "alert" },
  allocation: { pl: "Alokacja", en: "Allocation" },
  customRule: { pl: "Reguła własna", en: "Custom rule" },

  // ---- fact atoms
  win: { pl: plWin, en: enWin },
  /** "od szczytu 52 tyg." */
  fromHighWin: { pl: (d: Days) => `od szczytu ${plWin(d)}`, en: (d: Days) => `from the ${enWinAdj(d)}high` },
  /** "-12 % od szczytu" */
  fromHigh: { pl: (v: string) => `${v} od szczytu`, en: (v: string) => `${v} from the high` },
  vsCost: { pl: (v: string) => `${v} od kosztu`, en: (v: string) => `${v} vs cost` },
  fromCost: { pl: "od kosztu", en: "vs cost" },
  ofPortfolio: { pl: "portfela", en: "of the portfolio" },
  max: { pl: (v: string) => `maks ${v}`, en: (v: string) => `max ${v}` },
  min: { pl: (v: string) => `min ${v}`, en: (v: string) => `min ${v}` },
  above: { pl: (v: string) => `powyżej ${v}`, en: (v: string) => `above ${v}` },
  below: { pl: (v: string) => `poniżej ${v}`, en: (v: string) => `below ${v}` },
  /** A breakout edge / SMA side: "nad 140,00 zł" / "pod 120,00 zł". */
  overUnder: { pl: (over: boolean, v: string) => `${over ? "nad" : "pod"} ${v}`, en: (over: boolean, v: string) => `${over ? "above" : "below"} ${v}` },
  driftSide: { pl: (over: boolean, t: string) => `${over ? "nad celem" : "do celu"} ${t}`, en: (over: boolean, t: string) => `${over ? "above target" : "below target"} ${t}` },
  inSessions: { pl: (w: number | string) => `w ${w} sesji`, en: (w: number | string) => `in ${w} sessions` },
  threshold: { pl: "próg", en: "threshold" },
  band: { pl: "pasmo", en: "band" },
  now: { pl: (v: string) => `teraz ${v}`, en: (v: string) => `now ${v}` },
  lastContribution: { pl: "ostatnia wpłata", en: "last contribution" },
  last: { pl: "ostatnia", en: "last" },
  noContributions: { pl: "brak wpłat", en: "no contributions" },
  cash: { pl: "gotówka", en: "cash" },
  price: { pl: "cena", en: "price" },
  newLow: { pl: "nowy dołek", en: "new low" },
  newHigh: { pl: "nowy szczyt", en: "new high" },
  /** "nowy szczyt 52 tyg." / "new 52-week high" */
  newExtreme: { pl: (low: boolean, d: Days) => `${low ? "nowy dołek" : "nowy szczyt"} ${plWin(d)}`, en: (low: boolean, d: Days) => `new ${enWinAdj(d)}${low ? "low" : "high"}` },
  smaSide: { pl: (above: boolean, w: number) => `${above ? "nad" : "pod"} SMA ${w}`, en: (above: boolean, w: number) => `${above ? "above" : "below"} SMA ${w}` },
  breakout: { pl: "wybicie", en: "breakout" },
  breakoutJust: { pl: "tuż", en: "just" },
  volume: { pl: "wolumen", en: "volume" },
  ofAverage: { pl: "średniej", en: "the average" },
  alertWord: { pl: "Alert", en: "Alert" },
  thesisPre: { pl: "teza", en: "thesis" },
  recommendationPre: { pl: "rekomendacja", en: "recommendation" },
  noExitPlanTail: { pl: ", brak planu wyjścia", en: ", no exit plan" },
  vsCostNoExit: { pl: "od kosztu, brak planu wyjścia", en: "vs cost, no exit plan" },
  thesisHealth: { pl: (h: string) => `, teza ${h}`, en: (h: string) => `, thesis ${h}` },

  // ---- signal titles and tails
  concentrationTitle: { pl: (name: string) => `Koncentracja: ${name}`, en: (name: string) => `Concentration: ${name}` },
  overLimit: { pl: (m: string) => ` · ≈ ${m} nad limitem`, en: (m: string) => ` · ≈ ${m} over the limit` },
  outsideBand: { pl: (b: string) => `${b} poza pasmem`, en: (b: string) => `${b} outside the band` },
  belowTarget: { pl: (b: string) => `${b} poniżej celu`, en: (b: string) => `${b} below target` },
  noContribution: { pl: "Brak wpłaty", en: "No contribution" },
  contribPlan: {
    pl: (day: number | null, grace: number) => `· plan: co miesiąc${day ? ` do ${day}.` : ""} (+${grace} dni)`,
    en: (day: number | null, grace: number) => `· plan: monthly${day ? ` by day ${day}` : ""} (+${grace} days)`,
  },
  tooMuchCash: { pl: "Za dużo gotówki", en: "Too much cash" },
  tooLittleCash: { pl: "Za mało gotówki", en: "Too little cash" },
  shareTitle: { pl: (tags: string) => `Udział: ${tags}`, en: (tags: string) => `Share: ${tags}` },
  tags: { pl: "tagi", en: "tags" },
  priceBelow: { pl: "cena poniżej", en: "price below" },
  priceAbove: { pl: "cena powyżej", en: "price above" },
  dropFromHigh: { pl: "spadek od szczytu", en: "drop from the high" },
  smaCrossLead: {
    pl: (w: number | string, up: boolean) => `przecięcie SMA ${w} ${up ? "w górę" : "w dół"} ·`,
    en: (w: number | string, up: boolean) => `SMA ${w} cross ${up ? "up" : "down"} ·`,
  },
  /** "wybicie z konsolidacji 30 sesji" */
  breakoutFrom: { pl: (w: number) => `wybicie z konsolidacji ${w} sesji`, en: (w: number) => `breakout from a ${w}-session range` },
  avgOfSessions: { pl: (w: number) => `średniej ${w} sesji`, en: (w: number) => `the ${w}-session average` },

  // ---- alert conditions
  condPriceBelow: { pl: "cena poniżej poziomu", en: "price below the level" },
  condPriceAbove: { pl: "cena powyżej poziomu", en: "price above the level" },
  condChange: { pl: (w: number | string) => `zmiana w oknie ${w} sesji`, en: (w: number | string) => `change over ${w} sessions` },
  condDrawdown: { pl: (d: Days) => `spadek od szczytu ${plWin(d)}`, en: (d: Days) => `drop from the ${enWinAdj(d)}high` },
  condSma: {
    pl: (w: number, up: boolean) => `przecięcie średniej ${w}-dniowej ${up ? "w górę" : "w dół"}`,
    en: (w: number, up: boolean) => `${w}-day average cross ${up ? "up" : "down"}`,
  },
  condBucketWeightAbove: { pl: "waga koszyka powyżej", en: "bucket weight above" },
  condWeightAbove: { pl: "waga powyżej", en: "weight above" },
  condBucketWeightBelow: { pl: "waga koszyka poniżej", en: "bucket weight below" },
  condWeightBelow: { pl: "waga poniżej", en: "weight below" },
  condRange: {
    pl: (w: number, max: string) => `wybicie z zakresu ${w} sesji (zakres do ${max})`,
    en: (w: number, max: string) => `breakout from a ${w}-session range (range up to ${max})`,
  },
  condVolume: { pl: (r: string, w: number) => `wolumen ${r} średniej z ${w} sesji`, en: (r: string, w: number) => `volume ${r} the ${w}-session average` },
  condExpression: { pl: (e: string) => `wyrażenie: ${e}`, en: (e: string) => `expression: ${e}` },
  range: { pl: (lo: string, hi: string) => `zakres ${lo}-${hi}`, en: (lo: string, hi: string) => `range ${lo}-${hi}` },

  // ---- alert default title
  portfolio: { pl: "Portfel", en: "Portfolio" },
  /** "spadek 10 % od szczytu" */
  dropOf: { pl: (t: string) => `spadek ${t} od szczytu`, en: (t: string) => `${t} drop from the high` },
  customCondition: { pl: "warunek własny", en: "custom condition" },

  // ---- alert preview
  previewWho: { pl: "portfela", en: "the portfolio" },
  previewPriceBelow: {
    pl: (who: string, lvl: string, now: string | null) => `cena ${who} spadnie poniżej ${lvl}${now != null ? ` (teraz ${now})` : ""}`,
    en: (who: string, lvl: string, now: string | null) => `the price of ${who} falls below ${lvl}${now != null ? ` (now ${now})` : ""}`,
  },
  previewPriceAbove: {
    pl: (who: string, lvl: string, now: string | null) => `cena ${who} wzrośnie powyżej ${lvl}${now != null ? ` (teraz ${now})` : ""}`,
    en: (who: string, lvl: string, now: string | null) => `the price of ${who} rises above ${lvl}${now != null ? ` (now ${now})` : ""}`,
  },
  previewChange: {
    pl: (who: string, dir: unknown, t: string, w: number | string) => `kurs ${who} ${dir === "up" ? "wzrośnie" : dir === "down" ? "spadnie" : "zmieni się"} o co najmniej ${t} w ${w} sesjach`,
    en: (who: string, dir: unknown, t: string, w: number | string) => `${who} ${dir === "up" ? "rises" : dir === "down" ? "falls" : "moves"} by at least ${t} within ${w} sessions`,
  },
  previewDrawdown: {
    pl: (who: string, t: string, d: Days) => `${who} będzie ${t} poniżej szczytu z ${plWin(d)}`,
    en: (who: string, t: string, d: Days) => `${who} is ${t} below its ${enWinAdj(d)}high`,
  },
  previewNewHigh: {
    pl: (who: string, d: Days) => `${who} zamknie się na nowym szczycie z ${plWin(d)}`,
    en: (who: string, d: Days) => `${who} closes at a new ${enWinAdj(d)}high`,
  },
  previewSma: {
    pl: (who: string, w: number, up: boolean) => `cena ${who} przetnie średnią ${w}-dniową ${up ? "w górę" : "w dół"}`,
    en: (who: string, w: number, up: boolean) => `the price of ${who} crosses its ${w}-day average ${up ? "upward" : "downward"}`,
  },
  previewWeightAbove: { pl: (who: string, t: string) => `udział ${who} w portfelu przekroczy ${t}`, en: (who: string, t: string) => `the weight of ${who} in the portfolio exceeds ${t}` },
  previewWeightBelow: { pl: (who: string, t: string) => `udział ${who} w portfelu spadnie poniżej ${t}`, en: (who: string, t: string) => `the weight of ${who} in the portfolio falls below ${t}` },
  previewRange: {
    pl: (who: string, dir: string, w: number, max: string, tail: string) => `Zadziała, gdy kurs ${who} wyjdzie ${dir} poza zakres ostatnich ${w} sesji, o ile ten zakres był węższy niż ${max}.${tail}`,
    en: (who: string, dir: string, w: number, max: string, tail: string) => `Fires when ${who} breaks ${dir} out of the range of the last ${w} sessions, provided that range was narrower than ${max}.${tail}`,
  },
  previewVolume: {
    pl: (who: string, r: string, w: number, tail: string) => `Zadziała, gdy wolumen ${who} przekroczy ${r} średnią z ${w} sesji.${tail}`,
    en: (who: string, r: string, w: number, tail: string) => `Fires when the volume of ${who} exceeds ${r} the ${w}-session average.${tail}`,
  },
  previewCustom: { pl: (who: string) => `wyrażenie będzie prawdziwe dla ${who}`, en: (who: string) => `the expression is true for ${who}` },
  previewWhen: { pl: (when: string, tail: string) => `Zadziała, gdy ${when}.${tail}`, en: (when: string, tail: string) => `Fires when ${when}.${tail}` },
  notifyNow: { pl: "Powiadomienie od razu", en: "Notification right away" },
  notifyDigest: { pl: "Bez powiadomienia, w podsumowaniu tygodnia", en: "No notification, in the weekly digest" },
  columnPositive: { pl: "„Szanse\"", en: "\"Opportunities\"" },
  columnNegative: { pl: "„Ryzyka i przegląd\"", en: "\"Risks and review\"" },
  columnNeutral: { pl: "„Ryzyka i przegląd\" (neutralny)", en: "\"Risks and review\" (neutral)" },
  pause: {
    pl: (n: number) => `, pauza ${plCount(n, "dzień", "dni", "dni")} po spełnieniu`,
    en: (n: number) => `, paused for ${enCount(n, "day", "days")} after it fires`,
  },
  previewTail: {
    pl: (notify: string, column: string, pause: string) => ` ${notify}, sygnał w ${column}${pause}.`,
    en: (notify: string, column: string, pause: string) => ` ${notify}, signal in ${column}${pause}.`,
  },
  snoozedUntil: { pl: (d: string) => `uśpiony do ${d}`, en: (d: string) => `snoozed until ${d}` },
  expires: { pl: (d: string) => `wygasa ${d}`, en: (d: string) => `expires ${d}` },
  since: { pl: (d: string) => ` od ${d}`, en: (d: string) => ` since ${d}` },
  toLevel: { pl: (d: string, level: string) => `${d} do ${level}`, en: (d: string, level: string) => `${d} to ${level}` },

  // ---- re-entry, months
  gapMonths: { pl: (n: number) => `Wracasz po ${n} miesiącach`, en: (n: number) => `Back after ${n} months` },
  gapWeeks: { pl: (n: number) => `Wracasz po ${n} tygodniach`, en: (n: number) => `Back after ${n} weeks` },
  gapDay: { pl: "Wracasz po dniu", en: "Back after a day" },
  gapDays: { pl: (n: number) => `Wracasz po ${n} dniach`, en: (n: number) => `Back after ${n} days` },
  months: {
    pl: ["Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec", "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień"],
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  },
  monthsShort: {
    pl: ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"],
    en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },

  // ---- accounts, benchmark
  imported: { pl: (d: string) => `import ${d}`, en: (d: string) => `imported ${d}` },
  noImport: { pl: "bez importu", en: "no import" },
  none: { pl: "brak", en: "none" },
  noSnapshot: { pl: (imp: string) => `bez snapshotu · ${imp}`, en: (imp: string) => `no snapshot · ${imp}` },
  snapshot: {
    pl: (d: string, imp: string, warn: boolean) => `snapshot ${d} · ${imp}${warn ? " · starszy niż 14 dni" : ""}`,
    en: (d: string, imp: string, warn: boolean) => `snapshot ${d} · ${imp}${warn ? " · older than 14 days" : ""}`,
  },
  sameContributions: { pl: (name: string) => `${name}, te same wpłaty`, en: (name: string) => `${name}, same contributions` },
  benchmarkStale: { pl: "benchmark nieaktualny", en: "benchmark out of date" },
  benchmarkPricesUntil: { pl: (name: string, d: string) => `${name}: ceny do ${d}`, en: (name: string, d: string) => `${name}: prices until ${d}` },

  // ---- hints
  recOutdated: { pl: "rekomendacja nieaktualna", en: "recommendation outdated" },
  recCheckChip: { pl: "sprawdź rekomendację", en: "check recommendation" },
  recToCheck: { pl: "rekomendacja do sprawdzenia", en: "recommendation to check" },
  thesisInvalidated: { pl: "teza podważona", en: "thesis invalidated" },
  planVsThesisChip: { pl: "plan kontra teza", en: "plan vs thesis" },
  thesisFulfilled: { pl: "teza spełniona", en: "thesis fulfilled" },
  exitPlanTail: { pl: " · plan wyjścia", en: " · exit plan" },
  thesisReviewTail: { pl: " · przegląd tezy", en: " · thesis review" },
  over: { pl: (v: string) => `ponad ${v}`, en: (v: string) => `over ${v}` },
  concentration: { pl: "koncentracja", en: "concentration" },
  thesisWeakened: { pl: "teza osłabiona", en: "thesis weakened" },
  writeThesis: { pl: "zapisz tezę", en: "write a thesis" },
  noThesis: { pl: "bez tezy", en: "no thesis" },
  noExitPlan: { pl: "bez planu wyjścia", en: "no exit plan" },
  alertTitled: { pl: (t: string) => `alert: ${t}`, en: (t: string) => `alert: ${t}` },
  alertTriggered: { pl: "alert spełniony", en: "alert triggered" },
  buyWithoutThesis: { pl: "kup bez tezy", en: "buy without a thesis" },
  withReasons: { pl: (head: string, r: string) => `${head}: ${r}`, en: (head: string, r: string) => `${head}: ${r}` },
  invalidatedHeld: { pl: "zaszedł warunek unieważnienia tezy: zanotuj decyzję", en: "the thesis invalidation condition is met: record a decision" },
  invalidatedWatched: { pl: "zaszedł warunek unieważnienia tezy: zweryfikuj plan", en: "the thesis invalidation condition is met: review the plan" },
  planVsThesis: {
    pl: (plan: string, loc: string) => `plan ${plan || "zakupu"} przy tezie ${loc || "osłabionej"}: popraw plan albo tezę`,
    en: (plan: string, loc: string) => `${plan ? `"${plan}" plan` : "buy plan"} with a ${loc || "weakened"} thesis: fix the plan or the thesis`,
  },
  fulfilledNoPosition: { pl: "teza spełniona bez pozycji: zweryfikuj plan", en: "thesis fulfilled without a position: review the plan" },
  fulfilledNoExit: { pl: "teza spełniona, brak planu wyjścia: zapisz go", en: "thesis fulfilled, no exit plan: write one" },
  fulfilledCheckExit: { pl: "teza spełniona: sprawdź plan wyjścia", en: "thesis fulfilled: check the exit plan" },
  gain: { pl: "zysk", en: "gain" },
  loss: { pl: "strata", en: "loss" },
  drop: { pl: "spadek", en: "drop" },
  noExitWriteTail: { pl: ", brak planu wyjścia: zapisz go", en: ", no exit plan: write one" },
  checkExitTail: { pl: ": sprawdź plan wyjścia", en: ": check the exit plan" },
  thesisValidTail: { pl: ": czy teza jest aktualna?", en: ": is the thesis still valid?" },
  ofPortfolioPct: { pl: (p: string) => `${p} portfela`, en: (p: string) => `${p} of the portfolio` },
  portfolioShare: { pl: "udział w portfelu", en: "portfolio share" },
  concentrationReview: { pl: ": przegląd koncentracji", en: ": concentration review" },
  researchWeakens: { pl: "research osłabia tezę: przejrzyj notatki", en: "research weakens the thesis: review the notes" },
  noThesisHeld: { pl: "pozycja bez zapisanej tezy: zapisz tezę i warunek unieważnienia", en: "position without a written thesis: write the thesis and its invalidation condition" },
  noWrittenThesis: { pl: "bez zapisanej tezy", en: "no written thesis" },
  thesisNoExit: { pl: "teza bez planu wyjścia: uzupełnij go", en: "thesis without an exit plan: add one" },
  alertTriggeredTitled: { pl: (t: string) => `alert spełniony: ${t}. sprawdź tezę i plan`, en: (t: string) => `alert triggered: ${t}. check the thesis and plan` },
  alertTriggeredCheck: { pl: "alert spełniony: sprawdź tezę i plan", en: "alert triggered: check the thesis and plan" },
  planWithoutThesis: {
    pl: (plan: string) => `plan ${plan || "zakupu"} bez tezy: najpierw zapisz tezę`,
    en: (plan: string) => `${plan ? `"${plan}" plan` : "buy plan"} without a thesis: write the thesis first`,
  },

  // ---- freshness reasons
  /** "notatka podważa tezę" / "3 notatki podważają tezę" (Polish numeral agreement). */
  notesVerb: {
    pl: (n: number, relation: string) => {
      const [one, many, obj] = REL_VERB_PL[relation] ?? ["dotyczy", "dotyczą", "tezy"];
      if (n === 1) return `notatka ${one} ${obj}`;
      const n10 = n % 10, n100 = n % 100;
      const few = n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14);
      return `${n} ${few ? "notatki" : "notatek"} ${few ? many : one} ${obj}`;
    },
    en: (n: number, relation: string) => {
      const [one, many] = REL_VERB_EN[relation] ?? ["concerns", "concern"];
      return n === 1 ? `a note ${one} the thesis` : `${n} notes ${many} the thesis`;
    },
  },
  newNotes: { pl: (n: number) => plCount(n, "nowa notatka", "nowe notatki", "nowych notatek"), en: (n: number) => enCount(n, "new note", "new notes") },
  newNote: { pl: "nowa notatka", en: "new note" },
  noteRelation: { pl: (rel: string) => `notatka ${rel}`, en: (rel: string) => `a note ${rel}` },
  overOfPortfolio: { pl: (v: string) => `ponad ${v} portfela`, en: (v: string) => `over ${v} of the portfolio` },
  triggered: { pl: "spełniony", en: "triggered" },
  alertReason: { pl: (t: string) => `alert: ${t}`, en: (t: string) => `alert: ${t}` },

  // ---- instrument card
  rowRecommendation: { pl: "rekomendacja", en: "recommendation" },
  rowThesis: { pl: "teza", en: "thesis" },
  rowStrategy: { pl: "strategia", en: "strategy" },
  rowClass: { pl: "klasa", en: "class" },
  rowAccount: { pl: "rachunek", en: "account" },
  rowAccounts: { pl: "rachunki", en: "accounts" },
  researchStale: { pl: " · research nieaktualny", en: " · research out of date" },
  researchPre: { pl: " · research sprzed zmiany tezy", en: " · research predates the thesis change" },
  toClassify: { pl: "do sklasyfikowania", en: "to classify" },
  costInterest: { pl: "koszt + odsetki", en: "cost + interest" },
  manualValuation: { pl: "wycena ręczna", en: "manual valuation" },
  priceFrom: { pl: (d: string) => `cena z ${d}`, en: (d: string) => `price from ${d}` },
  labeled: { pl: (k: string, v: string) => `${k}: ${v}`, en: (k: string, v: string) => `${k}: ${v}` },

  // ---- asset header and timeline
  lots: { pl: (n: number) => plCount(n, "lot", "loty", "lotów"), en: (n: number) => enCount(n, "lot", "lots") },
  noLots: { pl: "brak lotów", en: "no lots" },
  txnsLoading: { pl: "transakcje", en: "transactions" },
  txns: { pl: (n: number) => plCount(n, "transakcja", "transakcje", "transakcji"), en: (n: number) => enCount(n, "transaction", "transactions") },
  dividends: { pl: "dywidendy", en: "dividends" },
  fees: { pl: "opłaty", en: "fees" },
  /** Units of a trade: "10 szt." */
  units: { pl: (q: string) => `${q} szt.`, en: (q: string) => `${q} units` },
  acknowledged: { pl: "Potwierdzone", en: "Acknowledged" },
  decision: { pl: "Decyzja", en: "Decision" },
  expired: { pl: "wygasł", en: "expired" },
  thesisReview: { pl: "Przegląd tezy", en: "Thesis review" },
});
