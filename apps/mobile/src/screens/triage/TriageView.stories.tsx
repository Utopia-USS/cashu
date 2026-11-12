// Stories of the categorize deck (CSF 3, invented payments): a card with the merchant's earlier
// category, a card without one (the grid right under the amount), a refused write, done and empty.
import { D, Money } from "@cashu/domain";
import type { CategoryOption } from "@cashu/ui/native";
import { TriageView, type TriageViewProps } from "./TriageView";

const pln = (amount: string) => new Money(D(amount), "PLN");

const options: CategoryOption[] = [
  { key: "groceries", label: "Groceries", swatch: "palette-1" },
  { key: "dining", label: "Dining out", swatch: "palette-2" },
  { key: "transport", label: "Transport", swatch: "palette-3" },
  { key: "shopping", label: "Shopping", swatch: "palette-4" },
  { key: "health", label: "Health", swatch: "palette-5" },
  { key: "home", label: "Home", swatch: "palette-6" },
  { key: "travel", label: "Travel", swatch: "palette-7" },
];

const rule = {
  on: false,
  onToggle: () => {},
  label: "Same for every Synthetic Pizza payment",
  sub: "Also past and future ones (3 so far)",
};

const withSuggestion: Extract<TriageViewProps, { kind: "card" }> = {
  kind: "card",
  done: 0,
  total: 4,
  dots: true,
  card: {
    gid: "synthetic-txn-1",
    payee: "Synthetic Pizza",
    amount: pln("-64.90"),
    dateLabel: "Wed, Nov 11",
    account: "Synthetic checking",
    statement: "SYNTHETIC PIZZA*ORDER 88213",
    suggestion: { key: "dining", label: "Dining out", swatch: "palette-2" },
  },
  next: { payee: "Synthetic Hardware", amount: pln("-129.99") },
  grid: {
    options,
    selected: null,
    suggested: "dining",
    expanded: false,
    onPick: () => {},
    onExpand: () => {},
  },
  rule,
  isSaving: false,
  error: null,
  onUseSuggestion: () => {},
  onSkip: () => {},
  onClose: () => {},
};

const meta = { title: "Mobile/Triage", component: TriageView, args: withSuggestion };
export default meta;

export const WithSuggestion = { args: withSuggestion };
export const WithoutSuggestion = {
  args: {
    ...withSuggestion,
    done: 2,
    card: {
      ...withSuggestion.card,
      gid: "synthetic-txn-3",
      payee: "Synthetic Kiosk",
      amount: pln("-18.50"),
      statement: null,
      suggestion: null,
    },
    next: null,
    grid: { ...withSuggestion.grid, suggested: null, expanded: true },
    rule: null,
  } satisfies TriageViewProps,
};
export const NotSaved = {
  args: {
    ...withSuggestion,
    rule: { ...rule, on: true },
    error: "Could not save. Try again.",
  } satisfies TriageViewProps,
};
export const LongDeck = {
  args: { ...withSuggestion, done: 12, total: 340, dots: false } satisfies TriageViewProps,
};
export const Done = {
  args: {
    kind: "done",
    count: 4,
    left: 0,
    onContinue: null,
    onClose: () => {},
  } satisfies TriageViewProps,
};
export const DoneMoreLeft = {
  args: {
    kind: "done",
    count: 50,
    left: 290,
    onContinue: () => {},
    onClose: () => {},
  } satisfies TriageViewProps,
};
export const Empty = {
  args: { kind: "empty", onClose: () => {} } satisfies TriageViewProps,
};
