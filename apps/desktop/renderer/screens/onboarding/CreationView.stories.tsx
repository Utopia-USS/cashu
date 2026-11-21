import { CreationView } from "./CreationView.js";
import type { CreationScreenState } from "./useCreationScreen.js";

const syntheticWords = Array.from({ length: 24 }, (_, index) => `sample${index + 1}`).join(" ");
const state = {
  phase: "profile",
  mode: "first",
  values: {
    name: "Synthetic Household",
    baseCurrency: "PLN",
    deviceAlias: "Synthetic laptop",
    modules: ["budget"],
    mcpPrivacy: null,
  },
  modules: [
    {
      id: "budget",
      name: "Budget",
      description: "Synthetic budget",
      available: true,
      dependsOn: [],
      selected: true,
    },
    {
      id: "assets",
      name: "Assets",
      description: "Synthetic assets",
      available: true,
      dependsOn: [],
      selected: false,
    },
  ],
  phrase: "",
  expiresAt: "",
  backupConfirmed: false,
  stage: null,
  refusal: null,
  checkingStatus: false,
  workspaceEnabled: true,
  workspacePath: "",
  routinePermissions: false,
  workspaceStatus: null,
  workspaceError: null,
  workspaceInspected: false,
  canClose: true,
  onClosed() {},
  onNameChanged() {},
  onCurrencyChanged() {},
  onDeviceAliasChanged() {},
  onModuleToggled() {},
  onPrivacyPicked() {},
  onWorkspaceEnabled() {},
  onWorkspacePathChanged() {},
  onRoutinePermissionsChanged() {},
  async onWorkspaceApply() {},
  async onWorkspaceInspect() {},
  async onWorkspaceSkip() {},
  onNext() {},
  onBack() {},
  async onPrepare() {},
  onBackupConfirmed() {},
  async onCommit() {},
  async onCheckStatus() {},
  onRestart() {},
} as unknown as CreationScreenState;

export default { title: "Desktop/Creation", component: CreationView, args: { state } };
export const FirstLaunch = {};
export const Additional = { args: { state: { ...state, mode: "additional" } } };
export const Modules = { args: { state: { ...state, phase: "modules" } } };
export const Privacy = {
  args: {
    state: { ...state, phase: "privacy", values: { ...state.values, mcpPrivacy: "strict" } },
  },
};
export const Recovery = {
  args: { state: { ...state, phase: "recovery", phrase: syntheticWords } },
};
export const Unavailable = { args: { state: { ...state, phase: "unavailable" } } };
export const Pending = { args: { state: { ...state, phase: "pending", stage: "history" } } };
export const Unknown = { args: { state: { ...state, phase: "unknown", stage: "admission" } } };
export const Ready = { args: { state: { ...state, phase: "ready" } } };
export const WorkspaceUnavailable = {
  args: { state: { ...state, phase: "workspace_unavailable" } },
};
export const WorkspaceReady = {
  args: {
    state: {
      ...state,
      phase: "workspace_ready",
      workspaceInspected: true,
      workspaceStatus: {
        availability: "ready",
        path: "/tmp/synthetic-workspace",
        defaultPath: "/tmp/synthetic-workspace",
        configured: false,
        upToDate: false,
        routinePermissions: false,
      },
    },
  },
};
export const WorkspaceUnknown = { args: { state: { ...state, phase: "workspace_unknown" } } };
