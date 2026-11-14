// This phone's default device name: the model ("iPhone 16 Pro", from expo-device), else "iPhone". The
// pairing code screen offers it for editing before the name goes into the vault's registry
// (`device.added`); the profile sheet shows it while the phone holds only the demo.
import { devices } from "@cashu/sync/engine";
import * as Device from "expo-device";

const FALLBACK = "iPhone";

/** The name for a model string: trimmed, or the fallback when it is missing or not a valid device name. */
export function deviceNameOf(model: string | null | undefined): string {
  const name = model?.trim() ?? "";
  return devices.isDeviceName(name) ? name : FALLBACK;
}

/** This phone's default name, read from the device model. */
export function defaultDeviceName(): string {
  return deviceNameOf(Device.modelName);
}
