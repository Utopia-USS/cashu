import type { ConnectorSettingsInput } from "@cashu/store/core/desktop-settings";
import { UiEnvProvider } from "@cashu/ui";
import { hmLocal, localDay } from "@cashu/ui-logic/core/time";
import { useForm } from "@tanstack/react-form";
import { SettingsView } from "./SettingsView.js";
import type { SettingsScreenState } from "./useSettingsScreen.js";

function SyntheticSettings({
  unavailable = false,
  approval = false,
  connectors = false,
  onConnectorAction = async () => {},
}: {
  unavailable?: boolean;
  approval?: boolean;
  connectors?: boolean;
  onConnectorAction?: (input: ConnectorSettingsInput) => Promise<void>;
}) {
  const profileForm = useForm({
    defaultValues: { name: "Synthetic Household", baseCurrency: "PLN" },
    onSubmit: async () => {},
  });
  const state = {
    vault: "5f0c3a9e81d24b7690ae13c7d2f4b856",
    identity: { slug: "synthetic" },
    current: { name: "Synthetic Household", baseCurrency: "PLN", mcpPrivacy: "strict" },
    profileForm,
    profileBusy: false,
    modules: [
      {
        id: "budget",
        enabled: true,
        available: true,
        name: "Budget",
        description: "Synthetic budget",
        setupState: "ready",
        dependsOn: [],
      },
      {
        id: "investments",
        enabled: true,
        available: true,
        name: "Investments",
        description: "Synthetic portfolio",
        setupState: "ready",
        dependsOn: [],
      },
    ],
    moduleBusy: false,
    onModuleToggled() {},
    onModuleConfigured() {},
    privacyBusy: false,
    onMcpPrivacyPicked: async () => {},
    connectorVault: "5f0c3a9e81d24b7690ae13c7d2f4b856",
    connectorSnapshot: connectors
      ? {
          connectors: [
            {
              id: "synthetic-fetch",
              name: "Synthetic fetch",
              kind: "fetch",
              module: "budget",
              approval: "approved",
              contentSha256: "a".repeat(64),
              interpreter: "/synthetic/interpreter",
              params: [{ id: "enabled", label: "Enabled", type: "boolean", required: false }],
              secrets: [{ id: "token", label: "Token" }],
            },
          ],
          accounts: [
            {
              gid: "6ad703ab-383d-8c73-82a5-1ee2d6742735",
              name: "Synthetic checking",
              type: "checking",
            },
          ],
          bindings: [
            {
              gid: "8ad703ab-383d-8c73-82a5-1ee2d6742735",
              account: "6ad703ab-383d-8c73-82a5-1ee2d6742735",
              connector_id: "synthetic-fetch",
              params_json: "{}",
              cursor: "page-2",
              auto_commit: 0,
            },
          ],
        }
      : null,
    connectorActivity: { runs: [], bindings: [] },
    connectorBusy: false,
    connectorAccounts: () => [
      { gid: "6ad703ab-383d-8c73-82a5-1ee2d6742735", name: "Synthetic checking", type: "checking" },
    ],
    bindConnector: async () => {},
    connectorRunFailure: () => null,
    onConnectorAction,
    installConnector: async () => {},
    workspace: unavailable
      ? { availability: "unavailable", reason: "source_unbound" }
      : {
          availability: "ready",
          path: "/tmp/synthetic-workspace",
          defaultPath: "/tmp/synthetic-workspace",
          configured: true,
          custom: false,
          exists: true,
          folderExists: true,
          conflict: null,
          upToDate: false,
          managedVersion: "1",
          currentVersion: "2",
          skillsSource: true,
          outdated: [{ kind: "skill", name: "review", reason: "outdated" }],
          skills: [{ name: "review", module: "investments", version: "2", state: "outdated" }],
          claudeCommand: "claude --add-dir /tmp/synthetic-workspace",
          routineCommand: null,
          routinePermissions: false,
          mcpCommandStale: false,
        },
    workspaceBusy: false,
    workspacePath: "/tmp/synthetic-workspace",
    editingPath: false,
    routinePermissions: false,
    setWorkspacePath() {},
    setEditingPath() {},
    setRoutinePermissions() {},
    refreshWorkspace: async () => {},
    saveWorkspace: async () => {},
    onWorkspaceCopied: async () => {},
    audit: {
      hidden: false,
      count7d: 1,
      calls: [
        {
          id: 1,
          tool: "synthetic_tool",
          calledAt: "2026-11-03T08:00:00Z",
          privacy: "strict",
          outcome: "ok",
          errorKind: null,
          durationMs: 12,
          arguments: [{ name: "scope", type: "str" }],
          unknownArgumentCount: 0,
        },
      ],
    },
    proposals: [{ gid: "019a48cf-0285-8a09-bf65-a2741b2c9a72", summary: "Synthetic proposal" }],
    onProposalOpened() {},
    preferences: { theme: "system", languagePin: "system", updatesAuto: false },
    hostInfo: unavailable
      ? { availability: "unavailable" }
      : {
          availability: "ready",
          version: "1.0.0",
          dataDir: "/tmp/synthetic-data",
          worker: {
            state: "idle",
            schedule: "07:30",
            nextRunAt: "2026-11-04T07:30:00Z",
            lastTickAt: "2026-11-03T07:30:00Z",
            jobs: [
              {
                job: "investments.daily",
                vault: "5f0c3a9e81d24b7690ae13c7d2f4b856",
                profileName: "Synthetic Household",
                status: "ok",
                startedAt: "2026-11-03T07:30:00Z",
                finishedAt: "2026-11-03T07:30:01Z",
              },
            ],
          },
        },
    worker: unavailable
      ? null
      : {
          state: "idle",
          schedule: "07:30",
          nextRunAt: "2026-11-04T07:30:00Z",
          nextRunDay: localDay("2026-11-04T07:30:00Z"),
          nextRunTime: hmLocal("2026-11-04T07:30:00Z"),
          lastTickAt: "2026-11-03T07:30:00Z",
          lastTickDay: localDay("2026-11-03T07:30:00Z"),
          lastTickTime: hmLocal("2026-11-03T07:30:00Z"),
          jobs: [
            {
              job: "investments.daily",
              vault: "5f0c3a9e81d24b7690ae13c7d2f4b856",
              profileName: "Synthetic Household",
              status: "ok",
              startedAt: "2026-11-03T07:30:00Z",
              startedDay: localDay("2026-11-03T07:30:00Z"),
              startedTime: hmLocal("2026-11-03T07:30:00Z"),
              finishedAt: "2026-11-03T07:30:01Z",
            },
          ],
        },
    service: { state: unavailable ? "unavailable" : approval ? "requires_approval" : "off" },
    serviceNextWakeDay: null,
    serviceNextWakeTime: "",
    serviceBusy: false,
    onServiceEnabled: async () => {},
    onDataDirCopied: async () => {},
    updater: { availability: "unavailable" },
    updaterBusy: false,
    onCheckUpdates: async () => {},
    onUpdatesAutoPicked: async () => {},
    onThemePicked: async () => {},
    onLanguagePicked: async () => {},
    notice: null,
    onNoticeDismissed() {},
    ownerIncognito: false,
  } as unknown as SettingsScreenState;
  return (
    <UiEnvProvider locale="en-US" privacy={false}>
      <SettingsView state={state} />
    </UiEnvProvider>
  );
}

export default { title: "Desktop/Settings/Full", component: SyntheticSettings };
export const Ready = { render: () => <SyntheticSettings /> };
export const UnboundProviders = { render: () => <SyntheticSettings unavailable /> };
export const ApprovalRequired = { render: () => <SyntheticSettings approval /> };
export const ConnectorsReady = { render: () => <SyntheticSettings connectors /> };
export function ConnectorRemovalFixture({
  onAction,
}: {
  onAction: (input: ConnectorSettingsInput) => Promise<void>;
}) {
  return <SyntheticSettings connectors onConnectorAction={onAction} />;
}
