import { toCurrency, views } from "@cashu/domain/investments";
import { strategyStatus, strategyTemplate } from "@cashu/domain/investments/strategy";
import type { StrategiesScreenState } from "./useStrategiesScreen.js";

const template = strategyTemplate("passive_etf");
if (!template) throw new Error("synthetic strategy template absent");
export const prose =
  "# Synthetic strategy\n\nPrivate synthetic investment prose.\n\n- [x] Review\n- Keep a long horizon\n\n| Bucket | Target |\n|---|---|\n| Synthetic | 80% |\n";
const status = strategyStatus({ yaml: template.yaml, md: prose, readError: null }, null);
const strategy = views.strategyStatusView({
  status,
  profileBase: toCurrency("PLN"),
  files: {
    yaml: "/synthetic/strategy.yaml",
    md: "/synthetic/strategy.md",
    yamlExists: true,
    mdExists: true,
  },
  versions: [],
  lang: "en",
});
const mainDocument = {
  id: "_main",
  main: true,
  executed: true,
  title: "Synthetic strategy",
  status: null,
  description: "Private synthetic description",
  mainFile: "strategy.md",
  root: "",
  files: [
    { path: "strategy.md", kind: "md" as const },
    { path: "strategy.yaml", kind: "yaml" as const },
  ],
};
const selection = { document: "_main", path: "strategy.md" };
export const readyState: StrategiesScreenState = {
  data: {
    status: "current",
    revision: "synthetic-revision",
    documents: [mainDocument],
    paths: {
      yaml: "/synthetic/strategy.yaml",
      md: "/synthetic/strategy.md",
      folder: "/synthetic/strategies",
    },
    selected: { status: "ready", selection, text: prose },
    strategy,
    currentIssues: status.result?.issues ?? [],
    inactiveRules: status.result?.inactiveRules ?? [],
    proposals: [
      { gid: "synthetic-proposal", summary: "Synthetic pending proposal", kind: "strategy" },
    ],
    versions: [{ version: 1, state: "valid", createdAt: "2026-10-31T12:00:00Z", issues: 0 }],
    canInit: false,
    canReload: true,
  },
  tree: [],
  lineIssues: [],
  docs: [mainDocument],
  doc: mainDocument,
  current: selection,
  selection,
  pick() {},
  mode: "preview",
  setMode() {},
  history: false,
  setHistory() {},
  notice: null,
  privacy: false,
  busy: false,
  async act() {},
  issues: [],
  inactiveRules: [],
  onProposalOpened: undefined,
  async copy() {},
};

export const unavailableState: StrategiesScreenState = {
  data: { status: "unavailable", reason: "capability_unavailable", proposals: [], versions: [] },
  tree: [],
  lineIssues: [],
  docs: [],
  doc: null,
  current: null,
  selection: null,
  pick() {},
  mode: "preview",
  setMode() {},
  history: false,
  setHistory() {},
  notice: null,
  privacy: false,
  busy: false,
  async act() {},
  issues: [],
  inactiveRules: [],
  onProposalOpened: undefined,
  async copy() {},
};
