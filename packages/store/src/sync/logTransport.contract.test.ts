// The S28a carrier contract with SqlLogTransport as every device's local log store (the phone's
// `log-<vault>.db`, one fresh in-memory database per device), under the production wiring of
// packages/sync/src/carriers/folder.contract.test.ts: the own-log carrier (manifest gating + signed
// codec) on a shared in-memory folder as the remote. A restart reopens the same local database.
import { createOwnLogCarrier, crypto, type DeviceId, FolderTransport } from "@cashu/sync";
import { describeCarrierContract, type TestSigners, testSigners } from "@cashu/sync/testing";
import { MemoryFolderFs } from "@cashu/sync/testing/folder";
import Database from "better-sqlite3";
import { betterSqlite3Driver } from "../sql/better-sqlite3.js";
import type { SqlDriver } from "../sql/driver.js";
import { SqlLogTransport } from "./logTransport.js";

const sodium = await crypto.loadNodeSodium();
const recovery = crypto.createRecoveryKey(sodium).publicKeys;

function carrierFor(fs: MemoryFolderFs, signers: TestSigners, device: DeviceId) {
  return createOwnLogCarrier({
    transport: new FolderTransport({ fs, owner: device }),
    codec: signers.codecFor(device),
    gate: signers.gateFor(device),
    device,
  });
}

describeCarrierContract({
  name: "own log over a shared folder, SqlLogTransport as the local log store (in-memory SQLite)",
  async createMedium(vault) {
    const fs = new MemoryFolderFs();
    const signers = testSigners(sodium, crypto.createKeyring(sodium, recovery, vault));
    const drivers: SqlDriver[] = [];
    return {
      remoteFor: (device) => carrierFor(fs, signers, device),
      codecFor: (device) => signers.codecFor(device),
      gateFor: (device) => signers.gateFor(device),
      localFor: (_device) => {
        const driver = betterSqlite3Driver(new Database(":memory:"));
        drivers.push(driver);
        const local = new SqlLogTransport({ driver, vault });
        local.ensureSchema();
        return local;
      },
      dispose: async () => {
        for (const d of drivers.splice(0)) d.close();
      },
    };
  },
});
