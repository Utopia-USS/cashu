// The proposal drawer for an agent's account removal: its tag, approve label, account facts and the
// Polish summary line. Synthetic proposal only.
import { lang, setLanguageForTests } from "@cashu/i18n";
import type { ProposalDetail } from "@cashu/store/core/desktop-proposals";
import { afterEach, expect, it } from "vitest";
import { A } from "./AccountRemovalProposal.strings.js";
import { proposalDrawerModel } from "./proposalDrawerModel.js";
import type { ProposalDrawerState } from "./useProposalDrawer.js";

const detail: ProposalDetail = {
  gid: "019a48cf-0285-8a09-bf65-a2741b2c9a72",
  kind: "account_removal",
  status: "pending",
  summary: "Remove account Synthetic bank checking 2 from view",
  summaryCode: "account_removal",
  summaryParams: { account: "Synthetic bank checking 2" },
  reason: "The owner closed it.",
  source: "agent",
  createdAt: "2026-11-09T08:00:00Z",
  reviewedAt: null,
  payload: { account: "01JSYNTHETICACCOUNT000000" },
  result: {},
  nextStrategyVersion: null,
  display: {
    diffAvailability: "unavailable",
    yamlDiff: null,
    mdDiff: null,
    baseChanged: null,
    ruleYaml: null,
    backtest: null,
    preview: null,
    account: "01JSYNTHETICACCOUNT000000",
    accountLabel: "Synthetic closed account",
    connectorName: null,
    fileName: null,
    since: null,
    fromConnector: false,
    converterUnsupported: false,
    detailError: null,
  },
};
const state: ProposalDrawerState = {
  detail,
  busy: false,
  message: null,
  failure: "",
  onApproved: async () => {},
  onRejected: async () => {},
} as ProposalDrawerState;

const initial = lang();
afterEach(() => setLanguageForTests(initial));

it("shows the account removal with the account's own name and what approving does", () => {
  for (const language of ["pl", "en"] as const) {
    setLanguageForTests(language);
    const m = proposalDrawerModel(state);
    expect(m.tag).toBe(A.kind);
    expect(m.approve).toBe(A.approve);
    expect(m.importFacts).toBeNull();
    expect(m.accountFacts).toEqual({
      account: { label: A.account, value: "Synthetic closed account" },
      effect: { label: A.effectLabel, value: A.effect },
    });
  }
  setLanguageForTests("pl");
  expect(proposalDrawerModel(state).summary).toBe(
    "Usunięcie konta Synthetic bank checking 2 z widoku",
  );
});
