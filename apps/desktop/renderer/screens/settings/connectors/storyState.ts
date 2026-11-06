// Synthetic connector state for the connectors Views' stories (only the fields these Views read).
import type { SettingsScreenState } from "../useSettingsScreen.js";

const account = {
  gid: "6ad703ab-383d-8c73-82a5-1ee2d6742735",
  name: "Synthetic checking",
  type: "checking",
};

type Snapshot = NonNullable<SettingsScreenState["connectorSnapshot"]>;

export const syntheticConnector = {
  id: "synthetic-fetch",
  name: "Synthetic fetch",
  kind: "fetch",
  module: "budget",
  approval: "approved",
  contentSha256: "a".repeat(64),
  interpreter: "/synthetic/interpreter",
  approvedAt: "2026-11-01T08:00:00.000Z",
  version: "1.0",
  author: "Synthetic",
  description: null,
  run: ["python3", "connector.py"],
  timeoutS: 60,
  hosts: ["api.example.test"],
  extensions: [],
  historyDays: 365,
  params: [{ id: "enabled", label: "Enabled", type: "boolean", required: false }],
  secrets: [{ id: "token", label: "Token" }],
} as unknown as Snapshot["connectors"][number];

export const connectorsState = {
  connectorVault: "5f0c3a9e81d24b7690ae13c7d2f4b856",
  connectorSnapshot: {
    connectors: [syntheticConnector],
    accounts: [account],
    bindings: [
      {
        gid: "8ad703ab-383d-8c73-82a5-1ee2d6742735",
        account: account.gid,
        connector_id: "synthetic-fetch",
        params_json: "{}",
        cursor: "page-2",
        auto_commit: 0,
      },
    ],
  },
  connectorActivity: {
    runs: [
      {
        id: 2,
        connectorId: "synthetic-fetch",
        binding: "8ad703ab-383d-8c73-82a5-1ee2d6742735",
        command: "fetch",
        startedAt: "2026-11-04T08:00:00.000Z",
        durationMs: 1250,
        outcome: "failed",
        errorKind: "auth_failed",
        records: 0,
        deniedHosts: [],
        stderrTail: "synthetic: key [secret] rejected",
      },
      {
        id: 1,
        connectorId: "synthetic-fetch",
        binding: "8ad703ab-383d-8c73-82a5-1ee2d6742735",
        command: "fetch",
        startedAt: "2026-11-03T08:00:00.000Z",
        durationMs: 820,
        outcome: "ok",
        errorKind: null,
        records: 12,
        deniedHosts: [],
        stderrTail: null,
      },
    ],
    bindings: [
      {
        binding: "8ad703ab-383d-8c73-82a5-1ee2d6742735",
        lastRunAt: "2026-11-04T08:00:00.000Z",
        lastStatus: "failed",
        lastOkAt: "2026-11-03T08:00:00.000Z",
        backoffUntil: null,
      },
    ],
  },
  connectorBusy: false,
  connectorAccounts: () => [account],
  bindConnector: async () => {},
  connectorRunFailure: () => null,
  onConnectorAction: async () => {},
  refreshConnectors: async () => {},
  installConnector: async () => {},
} as unknown as SettingsScreenState;

export const emptyConnectorsState = {
  ...connectorsState,
  connectorSnapshot: { connectors: [], accounts: [], bindings: [] },
} as unknown as SettingsScreenState;
