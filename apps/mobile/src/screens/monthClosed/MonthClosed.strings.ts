// The month-closed state (Today in the first days of a month, or pushed from Spending): what the
// closed month kept, what the synced strategy says about the surplus, the plan button and where the
// month went against a usual one. PL + EN. A month arrives as `MonthName`: its nominative (capitalized
// for a title) and the form that follows "of" (Polish genitive), both from `Intl`.
import { catalog } from "@cashu/i18n";
import type { MonthName } from "../../format/calendar";

export const S = catalog({
  monthClosed: {
    pl: (m: MonthName) => `${m.title} zamknięty`,
    en: (m: MonthName) => `${m.title} closed`,
  },
  keptIn: {
    pl: (m: MonthName) => `Zostało z ${m.of}`,
    en: (m: MonthName) => `Kept in ${m.name}`,
  },
  savingsRate: {
    pl: (pct: string) => `stopa oszczędności ${pct}`,
    en: (pct: string) => `savings rate ${pct}`,
  },
  income: { pl: "Wpływy", en: "Income" },
  spent: { pl: "Wydano", en: "Spent" },
  cushion: { pl: "Poduszka", en: "Cushion" },
  months: {
    pl: (months: string) => `${months} mies.`,
    en: (months: string) => `${months} mo.`,
  },
  strategySays: { pl: "Według Twojej strategii", en: "Your strategy says" },
  cushionFullPlan: {
    pl: (money: string) =>
      `Poduszka jest pełna, więc nadwyżka może pójść na inwestycje. Twój miesięczny plan to ${money}.`,
    en: (money: string) =>
      `The cushion is full, so the surplus can go to investing. Your monthly plan is ${money}.`,
  },
  cushionFull: {
    pl: "Poduszka jest pełna, więc nadwyżka może pójść na inwestycje.",
    en: "The cushion is full, so the surplus can go to investing.",
  },
  cushionShortTopUp: {
    pl: (money: string) =>
      `Poduszka nie jest jeszcze pełna: najpierw ${money} z nadwyżki trafia do niej.`,
    en: (money: string) => `The cushion is not full yet: ${money} of the surplus tops it up first.`,
  },
  monthlyPlan: {
    pl: (money: string) => `Twój miesięczny plan to ${money}.`,
    en: (money: string) => `Your monthly plan is ${money}.`,
  },
  plan: {
    pl: (money: string) => `Zaplanuj ${money}`,
    en: (money: string) => `Plan ${money}`,
  },
  otherAmount: { pl: "Inna kwota", en: "Other amount" },
  amount: { pl: "Kwota", en: "Amount" },
  amountError: { pl: "Wpisz kwotę większą od zera", en: "Enter an amount above zero" },
  amountTooLarge: { pl: "Ta kwota jest za duża", en: "That amount is too large" },
  alreadyBooked: {
    pl: "Ta wpłata jest już zaksięgowana, więc plan zostaje.",
    en: "This deposit is already booked, so the plan stays.",
  },
  couldNotSave: {
    pl: "Nie udało się zapisać. Spróbuj jeszcze raz.",
    en: "Could not save. Try again.",
  },
  planned: {
    pl: (money: string, m: MonthName) => `Zaplanowano ${money} na ${m.name}.`,
    en: (money: string, m: MonthName) => `Planned ${money} for ${m.name}.`,
  },
  noInvestingNote: {
    pl: "Nadwyżka zostaje na Twoich kontach. Ten profil nie ma skonfigurowanych inwestycji.",
    en: "The surplus stays on your accounts. Investing is not set up for this profile.",
  },
  planNote: {
    pl: "Plan to notatka dla Ciebie. cashU nigdy nie przelewa pieniędzy ani nie składa zleceń.",
    en: "A plan is a note to yourself. cashU never moves money or places orders.",
  },
  whereMonthWent: {
    pl: (m: MonthName) => `Wydatki z ${m.of}`,
    en: (m: MonthName) => `Where ${m.name} went`,
  },
  vsUsualHeader: { pl: "względem zwykłego", en: "vs usual" },
  asUsual: { pl: "jak zwykle", en: "as usual" },
  noSpending: { pl: "Brak wydatków", en: "No spending" },
  toToday: { pl: "Pokaż bieżący miesiąc", en: "Show the running month" },
});
