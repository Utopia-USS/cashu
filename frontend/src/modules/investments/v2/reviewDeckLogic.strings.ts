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
  skip: { pl: "Pomijam", en: "Skip" },
  opportunity: { pl: "Szansa", en: "Opportunity" },
  risk: { pl: "Ryzyko", en: "Risk" },
  signal: { pl: "Sygnał", en: "Signal" },
  toAct: { pl: " · do działania", en: " · to act on" },
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
