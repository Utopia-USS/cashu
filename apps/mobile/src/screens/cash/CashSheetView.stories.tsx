// Stories of the cash expense sheet (CSF 3, invented amounts): the first expense (no wallet yet,
// nothing typed), an amount typed into an existing wallet, a refused save and the same while amounts
// are hidden (the typed digits stay, the button drops the amount).
import { D, Money } from "@cashu/domain";
import { type CategoryOption, UiEnvProvider } from "@cashu/ui/native";
import type { ComponentType } from "react";
import { CashSheetView, type CashSheetViewProps } from "./CashSheetView";

const pln = (amount: string) => new Money(D(amount), "PLN");

const options: CategoryOption[] = [
  { key: "groceries", label: "Groceries", swatch: "palette-1" },
  { key: "dining", label: "Dining out", swatch: "palette-2" },
  { key: "transport", label: "Transport", swatch: "palette-3" },
  { key: "shopping", label: "Shopping", swatch: "palette-4" },
  { key: "health", label: "Health", swatch: "palette-5" },
  { key: "home", label: "Home", swatch: "palette-6" },
];

const days = [
  { key: "2026-11-12", label: "Today" },
  { key: "2026-11-11", label: "Yesterday" },
  { key: "2026-11-10", label: "Tue" },
  { key: "2026-11-09", label: "Mon" },
  { key: "2026-11-08", label: "Sun" },
  { key: "2026-11-07", label: "Sat" },
  { key: "2026-11-06", label: "Fri" },
];

const emptyWallet: CashSheetViewProps = {
  amount: { text: "", typed: "PLN 0", decimal: ".", money: pln("0"), onKey: () => {} },
  wallet: { balance: pln("0"), exists: false },
  grid: {
    options,
    selected: "groceries",
    suggested: null,
    expanded: false,
    onPick: () => {},
    onExpand: () => {},
  },
  title: { value: "", onChange: () => {}, placeholder: "What was it?" },
  date: { options: days, selected: "2026-11-12", onPick: () => {} },
  addLabel: "Add PLN 0.00",
  canSave: false,
  isSaving: false,
  error: null,
  onSave: () => {},
  onClose: () => {},
};

const typed: CashSheetViewProps = {
  ...emptyWallet,
  amount: { ...emptyWallet.amount, text: "45.5", typed: "PLN 45.5", money: pln("45.5") },
  wallet: { balance: pln("320.00"), exists: true },
  title: { ...emptyWallet.title, value: "Synthetic market stall" },
  date: { ...emptyWallet.date, selected: "2026-11-11" },
  addLabel: "Add -PLN 45.50",
  canSave: true,
};

const privacy = (Story: ComponentType) => (
  <UiEnvProvider locale="en-US" privacy>
    <Story />
  </UiEnvProvider>
);

const meta = { title: "Mobile/CashSheet", component: CashSheetView, args: emptyWallet };
export default meta;

export const EmptyWallet = { args: emptyWallet };
export const TypedAmount = { args: typed };
export const NotSaved = {
  args: { ...typed, error: "Say what it was." } satisfies CashSheetViewProps,
};
export const Incognito = {
  args: { ...typed, addLabel: "Add expense" } satisfies CashSheetViewProps,
  decorators: [privacy],
};
