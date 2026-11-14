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
  updateConnectorFetch,
} from "./connector-runs.js";
export {
  forgetPairedVault,
  type PairedVault,
  pairedVaults,
  savePairedVault,
} from "./paired.js";
export {
  type RelayMemberEntry,
  type RelayMemberRole,
  type RelaySetting,
  relayDeviceRole,
  relayMemberRole,
  relayMemberUid,
  relaySetting,
  relaySettingKey,
  relaySettingSchema,
  relaySettings,
  setRelaySetting,
} from "./relay.js";
export {
  currentVault,
  deviceLock,
  devicePhoneState,
  devicePreferences,
  markedAlerts,
  monthClosedSeen,
  notificationLedger,
  notificationPrefs,
  pricesFetchedAt,
  setAlertMarked,
  setCurrentVault,
  setDeviceLock,
  setDevicePhoneState,
  setDevicePreferences,
  setMonthClosedSeen,
  setNotificationLedger,
  setNotificationPrefs,
  setPricesFetchedAt,
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
