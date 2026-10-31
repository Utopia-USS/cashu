// The S28a carrier contract, unchanged, over the production carrier: the own-log carrier (manifest
// gating + S27 codec with compression) on the folder transport, on a real disk. Two media:
// one folder every device writes into directly (a local or network directory), and per-device
// replicas kept in step by a simulated sync service with random delays, reordering, partial
// downloads and conflict copies (iCloud Drive / Syncthing semantics).
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeviceId, FrameCodec } from "../carrier.js";
import { createKeyring, createRecoveryKey, loadNodeSodium } from "../crypto/index.js";
import { describeCarrierContract } from "../testing/index.js";
import { CloudSim } from "../transports/folder/testing/cloud.js";
import { NodeFolderFs } from "../transports/folder/testing/node-fs.js";
import { FolderTransport } from "../transports/folder/transport.js";
import type { FolderFs } from "../transports/index.js";
import { createOwnLogCarrier } from "./ownlog/carrier.js";
import { createOwnLogCodec } from "./ownlog/codec.js";

const sodium = await loadNodeSodium();
const recovery = createRecoveryKey(sodium).publicKeys;

function carrierFor(fs: FolderFs, codec: FrameCodec, device: DeviceId) {
  return createOwnLogCarrier({
    transport: new FolderTransport({ fs, owner: device }),
    codec,
    device,
  });
}

describeCarrierContract({
  name: "own log over a shared folder (Node fs)",
  async createMedium(vault) {
    const root = await mkdtemp(join(tmpdir(), "cashu-s28b-shared-"));
    const fs = new NodeFolderFs(root);
    const codec = createOwnLogCodec({ sodium, ring: createKeyring(sodium, recovery, vault) });
    return {
      remoteFor: (device) => carrierFor(fs, codec, device),
      codecFor: () => codec,
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  },
});

let seed = 1;

describeCarrierContract({
  name: "own log over an eventually synced folder (Node fs replicas, simulated sync service)",
  async createMedium(vault) {
    const root = await mkdtemp(join(tmpdir(), "cashu-s28b-eventual-"));
    const sim = new CloudSim({ seed: seed++, partialRate: 0.3, conflictRate: 0.3, maxDelay: 4 });
    const codec = createOwnLogCodec({ sodium, ring: createKeyring(sodium, recovery, vault) });
    const replica = async (device: DeviceId): Promise<FolderFs> => {
      const known = sim.replica(device);
      if (known) return known;
      const dir = join(root, device);
      await mkdir(dir, { recursive: true });
      const fs = new NodeFolderFs(dir);
      sim.addReplica(device, fs);
      await sim.flush(); // a new machine first downloads what the folder holds
      return fs;
    };
    return {
      remoteFor: async (device) => carrierFor(await replica(device), codec, device),
      codecFor: () => codec,
      settle: async () => {
        for (let i = 0; i < 3; i++) await sim.churn();
        await sim.flush();
      },
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  },
});
