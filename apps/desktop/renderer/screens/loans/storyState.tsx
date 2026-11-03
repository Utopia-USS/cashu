import { D, loans, Money } from "@cashu/domain";
import { useLoanForm } from "./useLoanForm.js";
import type { LoansState } from "./useLoansScreen.js";
import { usePaymentForm } from "./usePaymentForm.js";

const terms = {
  id: "01900000-0000-8000-8000-000000000001",
  accountId: "01900000-0000-8000-8000-000000000002",
  principal: D("12000"),
  annualRate: D("6.5"),
  termMonths: 120,
  startDate: "2026-01-31",
  originationDate: null,
  updatedAt: "2026-01-01T00:00:00Z",
  paymentIban: null,
  paymentText: null,
};
const row = {
  ...loans.loanSummary(
    terms,
    { id: terms.accountId, name: "Synthetic mortgage", type: "mortgage", currency: "PLN" },
    loans.loanValuation(terms, []),
    "2026-10-01",
    "PLN",
  ),
  matched: 0,
};
export const storyState: Omit<LoansState, "loanForm" | "paymentForm"> = {
  candidates: [],
  rows: [row],
  current: row,
  selected: row.id,
  setSelected: () => {},
  setup: {
    ok: true,
    value: {
      state: "partial",
      steps: [
        {
          id: "loan",
          title: "Loan",
          description: "Synthetic setup step",
          status: "done",
          optional: false,
          actions: [],
        },
      ],
      cliPrefix: "",
      skill: null,
    },
  },
  budgetOn: true,
  privacy: false,
  drawer: null,
  form: {
    name: "",
    type: "mortgage",
    principal: "12000",
    annualRate: "6.5",
    term: "10",
    unit: "years",
    startDate: "2026-01-31",
    originationDate: "",
    currency: "PLN",
  },
  mode: "text",
  setMode: () => {},
  text: "",
  setText: () => {},
  iban: "",
  setIban: () => {},
  error: null,
  notice: null,
  busy: false,
  matchingLoan: row,
  pickPayment: () => {},
  openLoan: () => {},
  openPayment: () => {},
  close: () => {},
  submitLoan: async () => {},
  submitPayment: async () => {},
  preview: new Money(D("136.26"), "PLN"),
  range: null,
  setRange: () => {},
  points: row.summary.schedule,
  chartLabels: [],
  chartSummary: "Synthetic chart summary",
  chartTip: () => ({ title: "Synthetic date", rows: [] }),
};

/** Real local form bindings keep stories independent of the store and router. */
export function StoryFixture({
  component: Component,
  state,
}: {
  component: import("react").ComponentType<{ state: LoansState }>;
  state?: Partial<LoansState>;
}) {
  const loanForm = useLoanForm("2026-10-01", "PLN", async () => {});
  const paymentForm = usePaymentForm(async () => true);
  return <Component state={{ ...storyState, loanForm, paymentForm, ...state }} />;
}
