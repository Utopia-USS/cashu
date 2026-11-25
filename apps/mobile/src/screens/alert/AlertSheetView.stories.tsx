// Stories of the alert sheet (CSF 3, invented figures): a fired risk alert waiting for a decision, a
// choice made, a refused write, one set aside for the review, one already decided, a rule signal without
// a thesis (no bell: rules are not marked), an alert this phone is told about, hidden amounts and an
// alert that is gone.
import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui/native";
import type { ComponentType } from "react";
import { AlertSheetView, type AlertSheetViewProps } from "./AlertSheetView";

type Ready = Extract<AlertSheetViewProps, { kind: "ready" }>;

const decision: NonNullable<Ready["decision"]> = {
  choice: null,
  onPick: () => {},
  reason: "",
  onReason: () => {},
  canSave: false,
  isSaving: false,
  error: null,
  canLater: true,
};

const fired: Ready = {
  kind: "ready",
  tag: { text: "Your alert · risk", tone: "negative" },
  title: "Quux Games fell 9.4% in 5 sessions",
  meta: "“QUX -8% in 5 sessions” · fired today 07:31",
  facts: [
    { kind: "text", label: "Price", value: "PLN 214.60", detail: "as of 07:31" },
    {
      kind: "money",
      label: "Your position",
      value: new Money(D("9657.00"), "PLN"),
      detail: "7.5% of the portfolio",
    },
    {
      kind: "percent",
      label: "Result",
      value: D("-0.1259"),
      detail: "average cost PLN 245.50",
    },
    { kind: "note", label: "Your size plan", value: "at most 8%, buy more only below PLN 205" },
  ],
  thesis: {
    wrongIf: "the 2027 release slips again",
    researchLine: {
      lead: "Research of Nov 7, 2026:",
      verdict: "weakens",
      tone: "negative",
      text: "Q3 and the 2027 slate",
    },
  },
  strategyLine: "A drawdown alone is not a reason to sell. Check the thesis, then decide.",
  tellPhone: { on: false, onToggle: () => {} },
  settled: null,
  decision,
  onSave: async () => {},
  onLater: async () => {},
  onClose: () => {},
};

const privacy = (Story: ComponentType) => (
  <UiEnvProvider locale="en-US" privacy>
    <Story />
  </UiEnvProvider>
);

const meta = { title: "Mobile/Investments/AlertSheet", component: AlertSheetView, args: fired };
export default meta;

export const Fired = { args: {} };

export const ChoiceMade = {
  args: { decision: { ...decision, choice: "held", reason: "results first", canSave: true } },
};

export const CouldNotSave = {
  args: {
    decision: { ...decision, choice: "sold", canSave: true, error: "Could not save. Try again." },
  },
};

export const SetAsideForReview = {
  args: {
    settled: "Decide later - back in your review",
    decision: { ...decision, canLater: false },
  },
};

export const TellsThisPhone = { args: { tellPhone: { on: true, onToggle: () => {} } } };

export const Decided = {
  args: { settled: "Noted: Nothing for now · Nov 12, 2026", decision: null },
};

export const RuleWithoutThesis = {
  args: {
    tag: { text: "Your rule", tone: "negative" },
    title: "QUX: 7.5% of the portfolio (max 5.0%).",
    meta: "“QUX: 7.5% of the portfolio (max 5.0%).” · fired today 06:45",
    facts: fired.facts.slice(0, 3),
    thesis: null,
    strategyLine: null,
    tellPhone: null,
  },
};

export const Incognito = {
  args: {
    facts: fired.facts.map((fact) =>
      fact.kind === "percent" ? { ...fact, detail: "average cost •••" } : fact,
    ),
  },
  decorators: [privacy],
};

export const Missing = { args: { kind: "missing", onClose: () => {} } };
