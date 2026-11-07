import {
  buildRecoveryPrompt,
  type StartupFailureReport,
  startupFailure,
} from "@cashu/host-protocol/startup-failure";
import type { ImportView } from "./RecoveryView.js";
import { RecoveryView } from "./RecoveryView.js";
import { importStages, recoveryDetails } from "./useRecoveryScreen.js";

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
});

const python = report(startupFailure("python_data_present", "python_data_found"));
const inventory = report(
  startupFailure("native_inventory_unavailable", "native_inventory_invalid", { vaults: 2 }),
);
const incomplete = report(startupFailure("migration_incomplete", "cutover_failed"));
const importFailed = report(startupFailure("migrate_import_failed", "source_changed"));
const unknown = report(startupFailure("unknown"));

/** Synthetic words (not a valid phrase). */
const WORDS = Array.from("abcdefghijklmnopqrstuvwx", (letter) => `story${letter}`).join(" ");

const idle: ImportView = {
  kind: "import",
  phase: "idle",
  stages: [],
  words: null,
  wordsConfirmed: false,
  notice: null,
  unpriced: [],
  mcpCommands: [],
  mcpNotice: null,
  agents: null,
  agentCommands: [],
};

const imp = (overrides: Partial<ImportView>): ImportView => ({ ...idle, ...overrides });

const actions = {
  notice: null,
  busy: false,
  canAct: true,
  importing: false,
  import: idle,
  onImport: () => {},
  onWordsConfirmed: () => {},
  onContinueImport: () => {},
  onCancelImport: () => {},
  onCopyMcp: () => {},
  onCopy: () => {},
  onOpenFolder: () => {},
  onRetry: () => {},
  onQuit: () => {},
};

export default {
  title: "Desktop/Shell/Recovery",
  component: RecoveryView,
  args: { ...actions, details: recoveryDetails(python), prompt: buildRecoveryPrompt(python, "en") },
};

export const PythonDataPresent = {};
export const Importing = {
  args: { importing: true, import: imp({ phase: "running", stages: importStages("import") }) },
};
export const RecoveryWords = {
  args: {
    importing: true,
    import: imp({ phase: "words", stages: importStages("import"), words: WORDS }),
  },
};
export const ImportCancelled = { args: { import: imp({ notice: "cancelled" }) } };
export const MigrationIncomplete = {
  args: {
    details: recoveryDetails(incomplete),
    prompt: buildRecoveryPrompt(incomplete, "en"),
    import: imp({ kind: "finish" }),
  },
};
export const ImportFailed = {
  args: {
    details: recoveryDetails(importFailed),
    prompt: buildRecoveryPrompt(importFailed, "en"),
    import: imp({ kind: null }),
  },
};
export const InventoryUnavailable = {
  args: {
    details: recoveryDetails(inventory),
    prompt: buildRecoveryPrompt(inventory, "en"),
    import: imp({ kind: null }),
  },
};
export const Unknown = {
  args: {
    details: recoveryDetails(unknown),
    prompt: buildRecoveryPrompt(unknown, "en"),
    import: imp({ kind: null }),
  },
};
const LAUNCHER = "'/Users/synthetic/Library/Application Support/cashU/bin/cashu'";
const MCP = ["synthetic", "synthetic-2"].flatMap((slug) => [
  `claude mcp remove cashu-${slug}`,
  `claude mcp add cashu-${slug} -- ${LAUNCHER} mcp --profile ${slug}`,
]);
export const ImportDone = {
  args: {
    import: imp({
      phase: "done",
      mcpCommands: MCP,
      agents: {
        bootout: "ran",
        agents: [
          { label: "io.utopiasoft.cashu.worker", state: "retired" },
          { label: "io.github.synszakala.finanse.worker", state: "absent" },
        ],
      },
    }),
  },
};
export const ImportDoneAgentFailed = {
  args: {
    import: imp({
      phase: "done",
      mcpCommands: MCP,
      mcpNotice: "copied",
      unpriced: [{ label: "SEUR", currency: "EUR", reason: "no_fx" }],
      agents: {
        bootout: "ran",
        agents: [
          { label: "io.utopiasoft.cashu.worker", state: "failed" },
          { label: "io.github.synszakala.finanse.worker", state: "absent" },
        ],
      },
      agentCommands: [
        "launchctl bootout gui/$(id -u)/io.utopiasoft.cashu.worker",
        "rm -f ~/Library/LaunchAgents/io.utopiasoft.cashu.worker.plist",
      ],
    }),
  },
};
export const Copied = { args: { notice: "copied" } };
export const ReportUnavailable = {
  args: { details: null, prompt: null, import: imp({ kind: null }) },
};
