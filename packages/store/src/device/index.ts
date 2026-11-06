// @cashu/store/device: the device-local store (current profile, device settings), never synced.

export { finishMcpCall, startMcpCall } from "./audit.js";
export {
  appendConnectorRun,
  type ConnectorFetchState,
  type ConnectorFetchUpdate,
  type ConnectorRunReadScope,
  type ConnectorRunRecord,
  connectorFetchState,
  ensureConnectorFetchState,
  ensureConnectorRunHistory,
  KEEP_CONNECTOR_RUNS,
  listConnectorRuns,
  type NewConnectorRun,
  restoreConnectorRuns,
  updateConnectorFetch,
} from "./connector-runs.js";
export {
  currentVault,
  devicePreferences,
  setCurrentVault,
  setDevicePreferences,
} from "./settings.js";
export {
  DEVICE_TABLES,
  type DeviceCommand,
  type DeviceCommandContext,
  type DeviceSettingKey,
  DeviceStore,
  defineDeviceCommand,
} from "./store.js";
export { type AppUpdateStage, type UpdateStatus, updateAction, updateStatus } from "./updates.js";
