import { ExpensesView } from "./ExpensesView.js";
import type { ExpensesState } from "./useExpensesScreen.js";

const noop = () => {};
const ready: ExpensesState = {
  bc: { currency: "PLN", codes: ["PLN", "EUR"], base: "PLN", setCurrency: noop },
  mode: "month",
  periodLabel: "lis 2026",
  canNav: true,
  step: noop,
  switchMode: noop,
  slices: [
    {
      key: "groceries",
      label: "Spożywcze",
      value: 400,
      amount: "400,00 zł",
      share: "80%",
      color: "palette-1",
    },
    {
      key: "fun",
      label: "Rozrywka",
      value: 100,
      amount: "100,00 zł",
      share: "20%",
      color: "palette-2",
    },
  ],
  total: "500,00 zł",
  openDrill: noop,
  drill: {
    title: "Transakcje · Spożywcze",
    sort: "date",
    order: "desc",
    rows: [
      {
        key: "t1",
        date: "2026-11-02",
        merchant: "SKLEP DEMO",
        details: null,
        account: "Konto demo",
        amount: "-400,00 zł",
        negative: true,
        category: "groceries",
      },
    ],
  },
  drillOptions: [{ value: "groceries", label: "Spożywcze" }],
  busy: false,
  setSort: noop,
  setOrder: noop,
  closeDrill: noop,
  markCategory: noop,
};

export default {
  title: "Desktop/Budget/Expenses",
  component: ExpensesView,
  args: { state: ready },
};
export const Ready = {};
export const Empty = { args: { state: { ...ready, slices: [], total: "0,00 zł", drill: null } } };
