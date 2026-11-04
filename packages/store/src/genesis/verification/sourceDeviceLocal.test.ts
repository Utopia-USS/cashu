import { describe, expect, it } from "vitest";
import { genesis } from "../index.js";
import { FILES, KEYS, NOW, seededDb } from "../testing/genesisData.js";
import { DeviceLocalSourceError, verifyDeviceLocalSource } from "./sourceDeviceLocal.js";

describe("independent device-local source accounting", () => {
  it("compares notification delivery and connector fetch state field by field", () => {
    const source = seededDb("0029");
    try {
      const result = genesis({ driver: source, files: FILES }, KEYS, { strict: true, now: NOW });
      const vault = result.vaults[0];
      if (!vault) throw new Error("synthetic fixture vault missing");
      const proof = verifyDeviceLocalSource(source, vault);
      expect(proof).toMatchObject({ notifications: 1, connectorFetch: 1 });
      const original = vault.deviceLocal.notifications[0];
      if (!original) throw new Error("synthetic fixture notification missing");
      const changed = {
        ...vault,
        deviceLocal: {
          ...vault.deviceLocal,
          notifications: [{ ...original, severity: "changed" }],
        },
      };
      expect(() => verifyDeviceLocalSource(source, changed)).toThrowError(
        new DeviceLocalSourceError(),
      );
      const fetch = vault.deviceLocal.connectorFetch[0];
      if (!fetch) throw new Error("synthetic fixture connector fetch state missing");
      const changedFetch = {
        ...vault,
        deviceLocal: {
          ...vault.deviceLocal,
          connectorFetch: [{ ...fetch, lastStatus: "changed" }],
        },
      };
      expect(() => verifyDeviceLocalSource(source, changedFetch)).toThrowError(
        new DeviceLocalSourceError(),
      );
    } finally {
      source.close();
    }
  });
});
