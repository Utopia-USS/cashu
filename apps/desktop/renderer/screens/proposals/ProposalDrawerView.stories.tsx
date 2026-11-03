import type { ProposalDetail } from "@cashu/store/core/desktop-proposals";
import { UiEnvProvider } from "@cashu/ui";
import { ProposalDrawerView } from "./ProposalDrawerView.js";
import type { ProposalDrawerState } from "./useProposalDrawer.js";

const detail = (kind: ProposalDetail["kind"]): ProposalDetail => ({
  gid: "019a48cf-0285-8a09-bf65-a2741b2c9a72",
  kind,
  status: "pending",
  summary: "Synthetic proposal",
  reason: "A synthetic reason for review",
  source: "synthetic",
  createdAt: "2026-11-03T08:00:00Z",
  reviewedAt: null,
  payload: {},
  result: {},
  nextStrategyVersion: kind === "strategy" || kind === "custom_rule" ? 3 : null,
  display: {
    diffAvailability: "ready",
    yamlDiff: "--- strategy.yaml (current)\n+++ strategy.yaml (proposed)\n@@ -1 +1 @@\n-old\n+new",
    mdDiff:
      kind === "strategy"
        ? "--- strategy.md (current)\n+++ strategy.md (proposed)\n@@ -1 +1 @@\n-old\n+new"
        : null,
    baseChanged: false,
    ruleYaml: kind === "custom_rule" ? "- id: synthetic" : null,
    backtest: kind === "custom_rule" ? { evaluated: 12, points_fired: 2, episodes: 1 } : null,
    preview:
      kind === "import" || kind === "budget_import" ? { new: 3, duplicates: 1, warnings: 1 } : null,
    account: kind === "import" ? "Synthetic account" : null,
    accountLabel: kind === "budget_import" ? "Synthetic budget" : null,
    connectorName: kind === "budget_import" ? "Synthetic connector" : null,
    fileName: "synthetic.csv",
    since: null,
    fromConnector: kind === "budget_import",
    converterUnsupported: false,
    detailError: null,
  },
});
const state = (kind: ProposalDetail["kind"], message: ProposalDrawerState["message"] = null) =>
  ({
    detail: detail(kind),
    busy: false,
    message,
    failure: "",
    onApproved() {},
    onRejected() {},
  }) as ProposalDrawerState;

export default {
  title: "Desktop/Proposals/Drawer",
  component: ProposalDrawerView,
  decorators: [
    (Story: () => React.ReactNode) => (
      <UiEnvProvider locale="en-US" privacy={false}>
        <Story />
      </UiEnvProvider>
    ),
  ],
  args: { state: state("strategy"), onClose() {} },
};
export const Strategy = {};
export const Rule = { args: { state: state("custom_rule") } };
export const InvestmentImport = { args: { state: state("import") } };
export const BudgetImport = { args: { state: state("budget_import") } };
export const RecoveryNeeded = { args: { state: state("strategy", "recoveryRestore") } };
export const UnavailableDiff = {
  args: {
    state: {
      ...state("strategy"),
      detail: {
        ...detail("strategy"),
        display: {
          ...detail("strategy").display,
          diffAvailability: "unavailable",
          yamlDiff: null,
          mdDiff: null,
        },
      },
    } as ProposalDrawerState,
  },
};
