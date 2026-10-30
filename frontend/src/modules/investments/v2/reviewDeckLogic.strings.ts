// Texts of the review deck's pure logic (src/modules/investments/v2/reviewDeckLogic.ts). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../../i18n.ts";

export const CARD = catalog({
  world: { pl: "Czy świat się wali", en: "Is the world falling apart" },
  sectors: { pl: "Sektory", en: "Sectors" },
  positions: { pl: "Pozycje: góra i dół", en: "Positions: top and bottom" },
  events: { pl: "Wydarzenia tygodnia", en: "Events of the week" },
  decide: { pl: "Do decyzji", en: "To decide" },
  ideas: { pl: "Okazje spoza portfela", en: "Ideas outside the portfolio" },
  calendar: { pl: "Kalendarz 14 dni", en: "14-day calendar" },
});

export const PROPOSAL_TAG_L = catalog({
  import: { pl: "Import do zatwierdzenia", en: "Import to approve" },
  strategy: { pl: "Zmiana strategii", en: "Strategy change" },
  custom_rule: { pl: "Nowa reguła", en: "New rule" },
  connector: { pl: "Nowy konektor", en: "New connector" },
});

/** Group headers on the Do decyzji card. */
export const GROUP_L = catalog({
  risk: { pl: "Ryzyka", en: "Risks" },
  chance: { pl: "Szanse", en: "Opportunities" },
  mixed: { pl: "Do przejrzenia", en: "To review" },
  plan: { pl: "W toku", en: "In progress" },
  fix: { pl: "Do poprawy", en: "To fix" },
});
/** The item's tag: what the item is; REL_TAG_L adds the research note's relation to the thesis. */
export const GROUP_TAG_L = catalog({
  risk: { pl: "Ryzyko", en: "Risk" },
  chance: { pl: "Szansa", en: "Opportunity" },
  mixed: { pl: "Do przejrzenia", en: "To review" },
  plan: { pl: "Plan w toku", en: "Plan in progress" },
  fix: { pl: "Do poprawy", en: "To fix" },
});
/** The research note's relation to the thesis, after the item's tag. */
export const REL_TAG_L = catalog({
  weakens: { pl: "teza osłabiona", en: "thesis weakened" },
  invalidates: { pl: "teza podważona", en: "thesis invalidated" },
  fulfills: { pl: "teza spełniona", en: "thesis fulfilled" },
});

export const S = catalog({
  // world
  noValuationPill: { pl: "brak wyceny", en: "no valuation" },
  noValuationTitle: { pl: "Brak wyceny portfela z początku tygodnia.", en: "No portfolio valuation from the start of the week." },
  calmWeek: { pl: "Spokojny tydzień.", en: "A calm week." },
  strongDown: { pl: "Mocny spadek.", en: "A strong fall." },
  strongUp: { pl: "Mocny wzrost.", en: "A strong rise." },
  rareDown: { pl: "Rzadko spotykany spadek.", en: "A rare fall." },
  rareUp: { pl: "Rzadko spotykany wzrost.", en: "A rare rise." },
  calmInline: { pl: " Portfel idzie razem z rynkiem.", en: " The portfolio moves with the market." },
  calmWorse: { pl: " Portfel trochę za rynkiem.", en: " The portfolio is a bit behind the market." },
  calmBetter: { pl: " Portfel trochę przed rynkiem.", en: " The portfolio is a bit ahead of the market." },
  downInline: { pl: " Rynek spadał podobnie.", en: " The market fell about as much." },
  downWorse: { pl: " Rynek też spadał, ale portfel mocniej.", en: " The market fell too, but the portfolio fell more." },
  downBetter: { pl: " Portfel stracił mniej niż rynek.", en: " The portfolio lost less than the market." },
  upInline: { pl: " Rynek rósł podobnie.", en: " The market rose about as much." },
  upWorse: { pl: " Rynek rósł jeszcze mocniej.", en: " The market rose even more." },
  upBetter: { pl: " Portfel rósł mocniej niż rynek.", en: " The portfolio rose more than the market." },
  pillNormal: { pl: "w normie", en: "normal" },
  pillStrongDown: { pl: "mocny spadek", en: "strong fall" },
  pillStrongUp: { pl: "mocny wzrost", en: "strong rise" },
  pillRare: { pl: "rzadki ruch", en: "rare move" },
  // sectors
  noTopic: { pl: "Bez tematu", en: "No topic" },
  currencies: { pl: "Waluty", en: "Currencies" },
  noSectors: { pl: "Brak podziału na sektory.", en: "No sector breakdown." },
  carriesAll: { pl: (l: string) => `${l} niesie cały wynik.`, en: (l: string) => `${l} carries the whole result.` },
  allPlus: { pl: "wszystko na plus", en: "all up" },
  allMinusTitle: { pl: (l: string) => `Wszystko na minus, najmocniej ${l}.`, en: (l: string) => `Everything down, ${l} the most.` },
  allMinus: { pl: "wszystko na minus", en: "all down" },
  and: { pl: " i ", en: " and " },
  shareOfMove: {
    pl: (names: string, pct: number, down: boolean) => `${names}: ${pct} % ${down ? "spadku" : "wzrostu"}.`,
    en: (names: string, pct: number, down: boolean) => `${names}: ${pct}% of the ${down ? "fall" : "rise"}.`,
  },
  spread: { pl: (names: string) => `Ruch rozłożony, najwięcej: ${names}.`, en: (names: string) => `A broad move, most from: ${names}.` },
  pillDown: { pl: "spadek", en: "fall" },
  pillUp: { pl: "wzrost", en: "rise" },
  // decide
  snooze: { pl: "Odłóż o tydzień", en: "Snooze for a week" },
  buyMore: { pl: "Dokupuję", en: "Buying more" },
  noChange: { pl: "Bez zmian", en: "No change" },
  selling: { pl: "Sprzedaję", en: "Selling" },
  accepted: { pl: "Przyjęte", en: "Noted" },
  planDone: { pl: "Zrealizowane", en: "Done" },
  planStands: { pl: "Plan aktualny", en: "Plan stands" },
  newSignal: { pl: "nowe", en: "new" },
  // decide: sentences (facts in words, never advice)
  half: { pl: "połowę", en: "half" },
  about: { pl: (f: string) => `ok. ${f}`, en: (f: string) => `about ${f}` },
  over: { pl: (f: string) => `ponad ${f}`, en: (f: string) => `over ${f}` },
  ddSentence: {
    pl: (share: string, threshold: string | null) => `Spadek o ${share} od rocznego szczytu${threshold ? ` przekroczył Twój próg ${threshold}` : ""}.`,
    en: (share: string, threshold: string | null) => `Down ${share} from the 52-week high${threshold ? `, past your ${threshold} threshold` : ""}.`,
  },
  lossSentence: { pl: (share: string) => `Pozycja ${share} pod kreską.`, en: (share: string) => `The position is ${share} below cost.` },
  gainSentence: { pl: (share: string) => `Pozycja zyskała ${share} od kosztu.`, en: (share: string) => `The position gained ${share} over cost.` },
  gainTimes: { pl: (n: number) => `Pozycja jest warta ponad ${n}× tyle, ile kosztowała.`, en: (n: number) => `The position is worth over ${n}× its cost.` },
  ladder: {
    pl: (n: number, since: string) => `To już ${n}. próg tej reguły; wcześniejsze czekają bez decyzji${since ? ` od ${since}` : ""}.`,
    en: (n: number, since: string) => `This is threshold ${n} of this rule; the earlier ones wait without a decision${since ? ` since ${since}` : ""}.`,
  },
  yourPlan: { pl: (plan: string) => `Twój plan: ${plan}`, en: (plan: string) => `Your plan: ${plan}` },
  noExitPlan: { pl: "Teza nie ma planu wyjścia.", en: "The thesis has no exit plan." },
  failsWhen: { pl: (when: string) => `Teza upada, gdy: ${when}`, en: (when: string) => `The thesis fails when: ${when}` },
  fixTag: { pl: "Do poprawy", en: "To fix" },
  fixTitle: {
    pl: (n: number) => `${n === 1 ? "Jeden sygnał wisi" : plCount(n, "sygnał wisi", "sygnały wiszą", "sygnałów wisi")} od tygodni`,
    en: (n: number) => `${n === 1 ? "One signal has" : `${enCount(n, "signal", "signals")} have`} been open for weeks`,
  },
  fixWhy: {
    pl: (rules: string, since: string) => `${rules}: bez decyzji${since ? ` od ${since}` : ""}.`,
    en: (rules: string, since: string) => `${rules}: no decision${since ? ` since ${since}` : ""}.`,
  },
  fixContext: {
    pl: "Reguła, która tyle wisi, jest pewnie źle ustawiona (cel, koszyki, plan wpłat) albo brakuje danych. Popraw ją w strategii albo oznacz w przeglądzie dla agenta.",
    en: "A rule open this long is likely set up wrong (target, buckets, deposit plan) or data is missing. Fix it in the strategy or flag it for the agent.",
  },
  thesisTag: { pl: "Teza", en: "Thesis" },
  thesisTitle: { pl: (name: string, h: string) => `${name}: teza ${h}`, en: (name: string, h: string) => `${name}: thesis ${h}` },
  was: { pl: (h: string) => `Była ${h}. `, en: (h: string) => `Was ${h}. ` },
  fulfilledWhy: { pl: "Teza się spełniła: sprawdź plan wyjścia.", en: "The thesis played out: check the exit plan." },
  againstWhy: { pl: "Research znalazł fakty przeciw tezie.", en: "Research found facts against the thesis." },
  reviewThesis: { pl: "Przejrzę tezę", en: "Review the thesis" },
  keep: { pl: "Trzymam", en: "Keep" },
  proposalTag: { pl: (kind: string) => `Propozycja agenta · ${kind}`, en: (kind: string) => `Agent proposal · ${kind}` },
  proposal: { pl: "Propozycja agenta", en: "Agent proposal" },
  awaitsApproval: { pl: "Czeka na Twoją akceptację.", en: "Waiting for your approval." },
  view: { pl: "Zobacz", en: "View" },
  // skipped cards
  skipSectors: { pl: "brak podziału na sektory", en: "no sector breakdown" },
  skipPositions: { pl: (min: string) => `brak ruchów powyżej ${min}`, en: (min: string) => `no moves above ${min}` },
  skipEvents: { pl: "brak ważnych wiadomości", en: "no important news" },
  skipDecide: { pl: "nic nie czeka na decyzję", en: "nothing waits for a decision" },
  skipIdeas: { pl: "brak nowych kandydatów", en: "no new candidates" },
  // summary
  doneNothing: { pl: "Gotowe. Nic nie wymaga dalszej uwagi.", en: "Done. Nothing needs more attention." },
  doneAgenda: {
    pl: (n: number) => `Gotowe. ${n === 1 ? "Jedna sprawa idzie" : plCount(n, "sprawa idzie", "sprawy idą", "spraw idzie")} do agenta.`,
    en: (n: number) => `Done. ${n === 1 ? "One item goes" : `${enCount(n, "item", "items")} go`} to the agent.`,
  },
});
