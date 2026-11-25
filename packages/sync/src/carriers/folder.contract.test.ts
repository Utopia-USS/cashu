// The S28a carrier contract, unchanged, over the production carrier: the own-log carrier (manifest
// gating + S27 codec with compression) on the folder transport, over the in-memory folder. Two media:
// one folder every device writes into directly (a local or network directory), and per-device
// replicas kept in step by a simulated sync service with random delays, reordering, partial
// downloads and conflict copies (iCloud Drive / Syncthing semantics). The same two media on a real
// disk, through the production Node adapter, run in packages/node-host (folderFs.test.ts).
import type { DeviceId, FrameGate } from "../carrier.js";
import { createKeyring, createRecoveryKey, loadNodeSodium } from "../crypto/index.js";
import { describeCarrierContract } from "../testing/index.js";
import { type TestSigners, testSigners } from "../testing/signers.js";
import { CloudSim } from "../transports/folder/testing/cloud.js";
import { MemoryFolderFs } from "../transports/folder/testing/memory-fs.js";
import { FolderTransport } from "../transports/folder/transport.js";
import type { FolderFs } from "../transports/index.js";
import { createOwnLogCarrier } from "./ownlog/carrier.js";

const sodium = await loadNodeSodium();
const recovery = createRecoveryKey(sodium).publicKeys;

function carrierFor(fs: FolderFs, signers: TestSigners, device: DeviceId) {
  const gate: FrameGate = signers.gateFor(device);
  return createOwnLogCarrier({
    transport: new FolderTransport({ fs, owner: device }),
    codec: signers.codecFor(device),
    gate,
    device,
  });
}

describeCarrierContract({
  name: "own log over a shared folder (in memory)",
  async createMedium(vault) {
    const fs = new MemoryFolderFs();
    const signers = testSigners(sodium, createKeyring(sodium, recovery, vault));
    return {
      remoteFor: (device) => carrierFor(fs, signers, device),
      codecFor: (device) => signers.codecFor(device),
      gateFor: (device) => signers.gateFor(device),
    };
  },
});

let seed = 1;

describeCarrierContract({
  name: "own log over an eventually synced folder (in-memory replicas, simulated sync service)",
  async createMedium(vault) {
    const sim = new CloudSim({ seed: seed++, partialRate: 0.3, conflictRate: 0.3, maxDelay: 4 });
    const signers = testSigners(sodium, createKeyring(sodium, recovery, vault));
    const replica = async (device: DeviceId): Promise<FolderFs> => {
      const known = sim.replica(device);
      if (known) return known;
      const fs = new MemoryFolderFs();
      sim.addReplica(device, fs);
      await sim.flush(); // a new machine first downloads what the folder holds
      return fs;
    };
    return {
      remoteFor: async (device) => carrierFor(await replica(device), signers, device),
      codecFor: (device) => signers.codecFor(device),
      gateFor: (device) => signers.gateFor(device),
      settle: async () => {
        for (let i = 0; i < 3; i++) await sim.churn();
        await sim.flush();
      },
    };
  },
});
