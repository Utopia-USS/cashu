// The default device name from the model string. Synthetic values only. Runs in the Node project, where
// expo-device's native module cannot load: a stand-in with a synthetic model.
import { defaultDeviceName, deviceNameOf } from "./deviceName";

jest.mock("expo-device", () => ({ modelName: "iPhone 15 Pro" }));

describe("deviceNameOf", () => {
  it("uses the model", () => {
    expect(deviceNameOf("iPhone 16 Pro")).toBe("iPhone 16 Pro");
    expect(deviceNameOf("  iPhone 15  ")).toBe("iPhone 15");
  });

  it("falls back to iPhone without a usable model", () => {
    expect(deviceNameOf(null)).toBe("iPhone");
    expect(deviceNameOf(undefined)).toBe("iPhone");
    expect(deviceNameOf("   ")).toBe("iPhone");
    expect(deviceNameOf("bad\nname")).toBe("iPhone");
    expect(deviceNameOf("x".repeat(500))).toBe("iPhone");
  });
});

it("reads the model of this phone", () => {
  expect(defaultDeviceName()).toBe("iPhone 15 Pro");
});
