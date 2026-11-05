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
