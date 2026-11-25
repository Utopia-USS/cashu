// Stories of the payment sheet (CSF 3, invented payments): an LLM suggestion waiting for the owner, a
// categorized payment whose payee is pinned, an own transfer, an inflow, a first payment to a payee,
// a refused write and a payment that is gone.
import { D, Money } from "@cashu/domain";
import type { CategoryOption } from "@cashu/ui/native";
import { PaymentSheetView, type PaymentSheetViewProps } from "./PaymentSheetView";

const pln = (amount: string) => new Money(D(amount), "PLN");

const options: CategoryOption[] = [
  { key: "groceries", label: "Groceries", swatch: "palette-1" },
  { key: "fuel", label: "Fuel", swatch: "palette-2" },
  { key: "dining", label: "Dining", swatch: "palette-3" },
  { key: "shopping", label: "Shopping", swatch: "palette-4" },
  { key: "car", label: "Car", swatch: "palette-5" },
  { key: "health", label: "Health", swatch: "palette-6" },
  { key: "gifts", label: "Gifts", swatch: "palette-7" },
];

const suggestion: Extract<PaymentSheetViewProps, { kind: "ready" }> = {
  kind: "ready",
  payee: "Allegro",
  amount: pln("-317.53"),
  dateLabel: "Nov 11, 2026",
  account: "Main account",
  statement: "ALLEGRO SP. Z O.O. 7781234",
  transfer: null,
  income: false,
  category: {
    options,
    selected: null,
    suggested: "shopping",
    suggestedLabel: "Shopping",
    expanded: false,
    collapsedCount: 5,
    onPick: () => {},
    onExpand: () => {},
    isSaving: false,
  },
  rule: {
    on: false,
    title: "Same for every Allegro payment",
    sub: "Also past and future ones (4 so far)",
    fixed: null,
    count: 4,
    enabled: false,
    onToggle: () => {},
    isSaving: false,
  },
  error: null,
  earlier: {
    rows: [
      { gid: "e1", dateLabel: "Oct 2, 2026", amount: pln("-89.99") },
      { gid: "e2", dateLabel: "Aug 17, 2026", amount: pln("-240.00") },
    ],
  },
  batch: "Imported Nov 11, 2026 · open banking",
  onClose: () => {},
};

const meta = {
  title: "Mobile/Payment/PaymentSheet",
  component: PaymentSheetView,
  args: suggestion,
};
export default meta;

export const UncategorizedWithSuggestion = { args: {} };

export const CategorizedRuleFixed = {
  args: {
    payee: "Orlen",
    amount: pln("-251.07"),
    statement: null,
    category: { ...suggestion.category, selected: "fuel", suggested: null, suggestedLabel: null },
    rule: {
      on: true,
      title: "Same for every Orlen payment",
      sub: "Always filed under Fuel",
      fixed: "Fuel",
      count: 12,
      enabled: true,
      onToggle: () => {},
      isSaving: false,
    },
  },
};

export const Transfer = {
  args: {
    payee: "Savings",
    amount: pln("-500.00"),
    statement: "Own transfer",
    transfer: { counterpart: "mBank Savings" },
    category: null,
    rule: null,
    earlier: { first: true },
    batch: null,
  },
};

export const Income = {
  args: {
    payee: "Employer Ltd",
    amount: pln("8200.00"),
    statement: "Salary 11/2026",
    income: true,
    category: null,
    rule: null,
  },
};

export const FirstPayment = {
  args: {
    payee: "Quux Studio",
    amount: pln("-60.00"),
    statement: null,
    category: { ...suggestion.category, suggested: null, suggestedLabel: null },
    rule: {
      on: false,
      title: "Same for every Quux Studio payment",
      sub: "Also past and future ones (1 so far)",
      fixed: null,
      count: 1,
      enabled: false,
      onToggle: () => {},
      isSaving: false,
    },
    earlier: { first: true },
  },
};

export const CouldNotSave = { args: { error: "Could not save. Try again." } };

export const Missing = { args: { kind: "missing", onClose: () => {} } };
