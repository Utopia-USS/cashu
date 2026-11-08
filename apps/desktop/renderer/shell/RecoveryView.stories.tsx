import {
  buildRecoveryPrompt,
  type StartupFailureReport,
  startupFailure,
} from "@cashu/host-protocol/startup-failure";
import { RecoveryView } from "./RecoveryView.js";
import { recoveryDetails } from "./useRecoveryScreen.js";

const report = (failure: StartupFailureReport["failure"]): StartupFailureReport => ({
  format: 1,
  failure,
  at: "2026-11-04T09:30:00.000Z",
  appVersion: "0.6.0",
  build: "desktop-dev",
  dataDir: "~/Library/Application Support/cashU",
  reportFile:
    "~/Library/Application Support/cashU/diagnostics/startup-failure-20261104T093000000Z.txt",
  logTail: [
    {
      at: "2026-11-04T09:30:00.000Z",
      level: "error",
      event: "host.start-failure",
      code: failure.code,
      error: "StartupFailureError",
    },
  ],
  omittedLogLines: 2,
  command: { kind: "launcher", path: "~/Library/Application Support/cashU/bin/cashu" },
  mcpServerPrefix: "cashu",
});

const python = report(
  startupFailure("python_data_present", "python_data_found", { pythonSources: 1 }),
);
const inventory = report(
  startupFailure("native_inventory_unavailable", "native_inventory_invalid", { vaults: 2 }),
);
const unknown = report(startupFailure("unknown"));

const actions = {
  notice: null,
  busy: false,
  canAct: true,
  onCopy: () => {},
  onOpenFolder: () => {},
  onRetry: () => {},
  onContinueWithoutOldData: () => {},
  onQuit: () => {},
};

export default {
  title: "Desktop/Shell/Recovery",
  component: RecoveryView,
  args: { ...actions, details: recoveryDetails(python), prompt: buildRecoveryPrompt(python, "en") },
};

export const PythonDataPresent = {};
export const InventoryUnavailable = {
  args: {
    details: recoveryDetails(inventory),
    prompt: buildRecoveryPrompt(inventory, "en"),
  },
};
export const Unknown = {
  args: {
    details: recoveryDetails(unknown),
    prompt: buildRecoveryPrompt(unknown, "en"),
  },
};
export const Copied = { args: { notice: "copied" } };
export const ReportUnavailable = {
  args: { details: null, prompt: null },
};
