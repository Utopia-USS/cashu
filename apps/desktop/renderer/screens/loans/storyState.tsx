import { D, loans } from "@cashu/domain";
import type { ComponentType } from "react";
import { initialLoanForm } from "./loanForm.js";
import { listRows, loanDetail, startSteps, stepsTag } from "./loansModel.js";
import type { LoansState } from "./useLoansScreen.js";

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
const noop = () => {};
const steps = [
  { id: "loan", status: "done" as const },
  { id: "payments", status: "on" as const },
];
/** The fake state, formatted now (call it with incognito on to get masked amounts). */
export function loansStoryState(privacy: boolean): LoansState {
  const name = privacy ? "•••" : "Synthetic mortgage";
  return {
    privacy,
    empty: false,
    rows: listRows([row], privacy),
    count: 1,
    selected: 0,
    select: noop,
    detail: loanDetail(row, name),
    range: null,
    setRange: noop,
    start: {
      tag: stepsTag({ state: "partial", steps }),
      mcpPrivacy: "strict",
      steps: startSteps({
        steps,
        budgetOn: true,
        loans: [row],
        base: "PLN",
        privacy,
        openLoan: noop,
        openPayment: noop,
      }),
    },
    drawer: null,
    busy: false,
    err: null,
    close: noop,
    loan: {
      form: {
        ...initialLoanForm("2026-10-01", "PLN"),
        principal: "12000",
        annualRate: "6,5",
        term: "10",
      },
      set: noop,
      errors: {},
      preview: "rata ≈ 136,26 zł · 120 rat",
      currencies: ["PLN", "EUR", "USD", "CHF"],
      save: noop,
    },
    payment: {
      loans: [{ value: row.accountId, label: name }],
      account: row.accountId,
      name,
      pick: noop,
      mode: "text",
      setMode: noop,
      text: "",
      setText: noop,
      iban: "",
      setIban: noop,
      storedTail: null,
      stored: false,
      candidates: [
        { key: "a", payee: "Synthetic bank", detail: "136,26 zł · co ok. 30 dni · ostatnio 5.10" },
      ],
      send: noop,
    },
  };
}
export const storyState = loansStoryState(false);
export const privacyState = loansStoryState(true);

/** Fake state and links keep stories independent of the store and router. */
export function StoryFixture({
  component: Component,
  state,
}: {
  component: ComponentType<{
    state: LoansState;
    onSetup(): void;
    onGuide(): void;
    onAgentSettings(): void;
  }>;
  state?: Partial<LoansState>;
}) {
  return (
    <Component
      state={{ ...storyState, ...state }}
      onSetup={noop}
      onGuide={noop}
      onAgentSettings={noop}
    />
  );
}
