import { StatementImportView } from "./StatementImportView.js";
import type { StatementImportState } from "./useStatementImport.js";

const noop = () => {};
const state = {
  title: "Statement import",
  steps: ["Source", "File", "Preview", "Done"],
  step: 0,
  error: null,
  onClose: noop,
  sources: [{ value: "csv", title: "Bank CSV file", desc: "Synthetic" }],
  source: "csv",
  onSource: noop,
  openBanking: false,
  ebConfigured: false,
  ebCommand: "cashu --profile demo eb login",
  onCopy: noop,
  fileKey: 0,
  onFile: noop,
  showBank: true,
  bank: "auto",
  bankOptions: [{ value: "auto", label: "Automatic" }],
  onBank: noop,
  accounts: [],
  accountId: "",
  accountOptions: [],
  onAccount: noop,
  accountType: "checking",
  typeOptions: [{ value: "checking", label: "Checking" }],
  onAccountType: noop,
  accountName: "",
  onAccountName: noop,
  footer: { kind: "source", next: "Next", nextDisabled: false },
  onNext: noop,
  onBack: noop,
  onInstructions: noop,
  onPreview: noop,
} as unknown as StatementImportState;

export default {
  title: "Budget/StatementImport",
  component: StatementImportView,
  args: { state },
};
export const Source = {};
export const File = {
  args: {
    state: {
      ...state,
      step: 1,
      footer: { kind: "file", back: "Back", run: "Preview", runDisabled: true },
    },
  },
};
