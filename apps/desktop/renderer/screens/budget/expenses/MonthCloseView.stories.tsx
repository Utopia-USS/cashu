import { MonthCloseView } from "./MonthCloseView.js";
import type { MonthCloseState } from "./useMonthClose.js";

const noop = () => {};
const ready: MonthCloseState = {
  month: "paź 2026",
  inProgress: false,
  prevDisabled: false,
  nextDisabled: false,
  step: noop,
  noTransactions: null,
  figures: {
    income: "11 800,00 zł",
    spending: "4 785,60 zł",
    surplus: "7 014,40 zł",
    surplusNegative: false,
    toInvest: "5 014,40 zł",
    toInvestHint: "po dopłacie do poduszki 2 000,00 zł",
  },
  top: [{ key: "rent", label: "Mieszkanie/Czynsz", amount: "780,00 zł", share: "16%" }],
  cats: [{ key: "rent", label: "Mieszkanie/Czynsz", amount: "780,00 zł", share: "16%" }],
  allCats: false,
  toggleCats: noop,
  cushion: "0,00 zł z 14 851,80 zł · dopłata 2 000,00 zł",
  cushionTitle: undefined,
  editDisabled: false,
  plan: { text: "2 500,00 zł / mies.", tag: { tone: "positive", text: "pokrywa plan" } },
  others: null,
  form: null,
  toggleForm: noop,
};

export default {
  title: "Desktop/Budget/Month close",
  component: MonthCloseView,
  args: { state: ready },
};
export const Ready = {};
export const Empty = {
  args: { state: { ...ready, figures: null, noTransactions: "Brak transakcji w PLN." } },
};
