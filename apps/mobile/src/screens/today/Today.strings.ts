// The Today tab: the running month's "on track to keep", its pace against a usual month, the
// attention rows ("Worth a look"), the next 7 days, where the money went and the stale-data banner.
// PL + EN. A weekday or a date arrives as `When`: a weekday index (0 = Sunday, as `Date.getDay`) the
// Polish copy inflects itself, or a finished date label.
import { catalog, enCount, enForm, plCount, plForm } from "@cashu/i18n";

/** A weekday index (0 = Sunday) or a finished date label. */
export type When = number | string;

const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Genitive ("stan z poniedziałku"). */
const PL_WEEKDAYS_OF = [
  "niedzieli",
  "poniedziałku",
  "wtorku",
  "środy",
  "czwartku",
  "piątku",
  "soboty",
];

const enWhen = (when: When) => (typeof when === "number" ? (EN_WEEKDAYS[when] ?? "") : when);
const plWhen = (when: When) => (typeof when === "number" ? (PL_WEEKDAYS_OF[when] ?? "") : when);

/** "1st", "2nd", "3rd", "10th" (written out: Hermes on iOS has no `Intl.PluralRules`). */
function enOrdinal(n: number): string {
  const tens = n % 100;
  const ones = n % 10;
  const suffix =
    tens >= 11 && tens <= 13
      ? "th"
      : ones === 1
        ? "st"
        : ones === 2
          ? "nd"
          : ones === 3
            ? "rd"
            : "th";
  return `${n}${suffix}`;
}

export const S = catalog({
  onTrackToKeep: { pl: "Zostanie Ci", en: "On track to keep" },
  /** Appended to a hero label while amounts show in bananas. */
  inBananas: { pl: ", w bananach", en: ", in bananas" },
  daysToGo: {
    pl: (n: number) =>
      n === 0 ? "ostatni dzień" : `jeszcze ${n} ${plForm(n, "dzień", "dni", "dni")}`,
    en: (n: number) => (n === 0 ? "last day" : `${n} ${enForm(n, "day", "days")} to go`),
  },
  byMonthEnd: {
    pl: (date: string) => `do ${date}, jeśli reszta miesiąca pójdzie jak zwykle`,
    en: (date: string) => `by ${date}, if the rest of the month goes like usual`,
  },
  inclUsualPay: {
    pl: (day: number) => `w tym wypłata, która zwykle wpływa ${day}. dnia`,
    en: (day: number) => `incl. your usual pay on the ${enOrdinal(day)}`,
  },
  asOf: {
    pl: (when: When) => `stan z ${plWhen(when)}`,
    en: (when: When) => `as of ${enWhen(when)}`,
  },
  spendingVsUsual: { pl: "Wydatki na tle typowego miesiąca", en: "Spending vs a usual month" },
  underUsual: {
    pl: (money: string) => `na razie ${money} mniej niż zwykle`,
    en: (money: string) => `${money} under usual so far`,
  },
  overUsual: {
    pl: (money: string) => `na razie ${money} więcej niż zwykle`,
    en: (money: string) => `${money} over usual so far`,
  },
  paceAsOf: {
    pl: (when: When) => `tempo według stanu z ${plWhen(when)}`,
    en: (when: When) => `pace as of ${enWhen(when)}`,
  },
  income: { pl: "Wpływy", en: "Income" },
  spent: { pl: "Wydano", en: "Spent" },
  billsStillDue: { pl: "Rachunki do zapłaty", en: "Bills still due" },
  worthALook: { pl: "Warto zerknąć", en: "Worth a look" },
  notCategorized: {
    pl: (money: string) => `${money} bez kategorii`,
    en: (money: string) => `${money} not categorized`,
  },
  projectionMayBeOff: {
    pl: "prognoza może być niedokładna",
    en: "your projection may be off",
  },
  mostlyAt: {
    pl: (payee: string, date: string) => `głównie ${payee}, ${date}`,
    en: (payee: string, date: string) => `mostly ${payee}, ${date}`,
  },
  ofSpending: { pl: "wydatków", en: "of spending" },
  billNotCovered: {
    pl: (payee: string) => `Za mało środków na ${payee}`,
    en: (payee: string) => `Not enough money for ${payee}`,
  },
  dueFromAccount: {
    pl: (date: string, account: string | null) =>
      account === null ? `płatne ${date}` : `płatne ${date} z konta ${account}`,
    en: (date: string, account: string | null) =>
      account === null ? `due ${date}` : `due ${date} from ${account}`,
  },
  short: { pl: "brakuje", en: "short" },
  positionMoved: {
    pl: (name: string) => `${name}: warto sprawdzić`,
    en: (name: string) => `${name} needs a look`,
  },
  ofPortfolio: { pl: "portfela", en: "of portfolio" },
  payeeCostsMore: {
    pl: (payee: string) => `${payee}: wyższa cena`,
    en: (payee: string) => `${payee} costs more`,
  },
  fromTo: {
    pl: (from: string, to: string, date: string) => `z ${from} na ${to}, od ${date}`,
    en: (from: string, to: string, date: string) => `${from} to ${to}, from ${date}`,
  },
  aYear: { pl: "rocznie", en: "a year" },
  newRecurring: {
    pl: (payee: string) => `Nowa płatność cykliczna: ${payee}`,
    en: (payee: string) => `New regular payment: ${payee}`,
  },
  everyNDays: {
    pl: (n: number) => `co ${n} ${plForm(n, "dzień", "dni", "dni")}`,
    en: (n: number) => `every ${n} ${enForm(n, "day", "days")}`,
  },
  perCharge: { pl: "za płatność", en: "per charge" },
  staleTitle: {
    pl: (hours: number) => {
      const days = Math.floor(hours / 24);
      return `Dane z banku mają ${plCount(days, "dzień", "dni", "dni")}`;
    },
    en: (hours: number) => {
      const days = Math.floor(hours / 24);
      return `Bank data is ${enCount(days, "day", "days")} old`;
    },
  },
  staleBody: {
    pl: "Mac pobiera je raz dziennie, gdy jest włączony i ma internet; notowania trafiają na ten telefon na bieżąco. Otwórz Maca, żeby nadrobić - na telefonie nic nie trzeba robić.",
    en: "It is fetched once a day when the Mac is awake and online; prices still come live to this phone. Open it to catch up - nothing to do on this phone.",
  },
  consentTitle: {
    pl: (bank: string, days: number) =>
      `Zgoda banku ${bank} wygasa za ${plCount(days, "dzień", "dni", "dni")}`,
    en: (bank: string, days: number) => `${bank} access ends in ${enCount(days, "day", "days")}`,
  },
  consentBody: {
    pl: "Odnów ją na Macu, żeby dane z banku dalej spływały.",
    en: "Renew it on the Mac so the bank data keeps coming.",
  },
  next7Days: { pl: "Najbliższe 7 dni", en: "Next 7 days" },
  covered: { pl: "pokryte", en: "covered" },
  nothingDue: { pl: "Nic do zapłaty", en: "Nothing due" },
  plannedDeposit: { pl: "Zaplanowana wpłata", en: "Planned deposit" },
  whereItWent: { pl: "Na co poszły pieniądze", en: "Where it went" },
  allCategories: { pl: "Wszystkie kategorie", en: "All categories" },
  moreCategories: {
    pl: (n: number) => `jeszcze ${plCount(n, "kategoria", "kategorie", "kategorii")}`,
    en: (n: number) => `${n} more ${enForm(n, "category", "categories")}`,
  },
  /** Followed by " · " and the sum (a value component). */
  smallUncategorized: {
    pl: (n: number) =>
      `${plCount(n, "drobna płatność", "drobne płatności", "drobnych płatności")} bez kategorii`,
    en: (n: number) => `${enCount(n, "small payment", "small payments")} without a category`,
  },
  categorize: { pl: "Przypisz kategorie", en: "Categorize" },
  bankNote: {
    pl: "Dane z banku przychodzą z Twojego Maca raz dziennie - ten telefon nigdy sam nie łączy się z bankiem. Notowania pobiera sam.",
    en: "Bank data comes from your Mac once a day - this phone never asks your bank on its own. Prices it fetches itself.",
  },
  showingBase: {
    pl: (currency: string, other: string) =>
      `Kwoty w ${currency}; konta w ${other} są w zakładce Wartość netto.`,
    en: (currency: string, other: string) =>
      `Showing ${currency}; your ${other} accounts are on Net worth.`,
  },
});
