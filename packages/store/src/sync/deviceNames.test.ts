// The device names a phone shows from its registry fold: its own name and pairing day, and the device
// that paired it. Synthetic records only.
import type { devices } from "@cashu/sync/engine";
import { formatHlc } from "@cashu/sync/hlc";
import { describe, expect, it } from "vitest";
import { vaultDeviceNames } from "./deviceNames.js";

const MAC = "a1000000000000000000000000000001";
const PHONE = "b2000000000000000000000000000002";
const ADDED = Date.UTC(2026, 10, 3, 9, 30);

function record(deviceId: string, name: string, pairedBy: string): devices.DeviceRecord {
  return {
    deviceId,
    name,
    addedEid: `eid-${deviceId}`,
    pairedBy,
    pairedAt: {
      position: { seg: 1, offset: 0 },
      hlc: formatHlc({ wall: ADDED, counter: 0, device: pairedBy }),
    },
  };
}

function holder(deviceId: string, records: readonly devices.DeviceRecord[]) {
  return {
    deviceId,
    devices: { registry: { devices: new Map(records.map((r) => [r.deviceId, r])) } },
  };
}

describe("vaultDeviceNames", () => {
  it("names this device and the device that paired it", () => {
    const names = vaultDeviceNames(
      holder(PHONE, [record(MAC, "Mac Studio", MAC), record(PHONE, "iPhone 16 Pro", MAC)]),
    );
    expect(names).toEqual({
      self: { name: "iPhone 16 Pro", addedAt: ADDED },
      pairedBy: { deviceId: MAC, name: "Mac Studio" },
    });
  });

  it("has no inviter for the vault's creator", () => {
    expect(vaultDeviceNames(holder(MAC, [record(MAC, "Mac Studio", MAC)]))).toEqual({
      self: { name: "Mac Studio", addedAt: ADDED },
    });
  });

  it("knows nothing before this device's device.added is folded", () => {
    expect(vaultDeviceNames(holder(PHONE, [record(MAC, "Mac Studio", MAC)]))).toEqual({});
  });
});
