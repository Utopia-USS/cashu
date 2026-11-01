// @cashu/store/device: the device-local store (current profile, device settings), never synced.

export { finishMcpCall, startMcpCall } from "./audit.js";
export { currentVault, setCurrentVault } from "./settings.js";
export {
  DEVICE_TABLES,
  type DeviceCommand,
  type DeviceCommandContext,
  type DeviceSettingKey,
  DeviceStore,
  defineDeviceCommand,
} from "./store.js";
