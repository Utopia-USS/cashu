// The production Node FolderFs: port semantics on a temp disk (private modes, the root never
// created, `unavailable` when the root is gone, paths kept under the root), then the S28a carrier
// contract suite unchanged over the own-log carrier on this adapter (shared folder and replicas kept
// in step by the simulated sync service), as packages/sync runs it over its test adapter.
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOwnLogCarrier,
  crypto,
  type DeviceId,
  type FolderFs,
  FolderTransport,
  TransportError,
} from "@cashu/sync";
import { describeCarrierContract, type TestSigners, testSigners } from "@cashu/sync/testing";
import { CloudSim } from "@cashu/sync/testing/folder";
import { describe, expect, it } from "vitest";
import { NodeFolderFs } from "./folderFs.js";

const tempRoot = (name: string) =>
  mkdtemp(join(realpathSync(tmpdir()), `cashu-node-host-${name}-`));
const mode = async (path: string) => (await stat(path)).mode & 0o777;
const bytes = (...xs: number[]) => Uint8Array.from(xs);

async function errorCode(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
    return undefined;
  } catch (e) {
    return e instanceof TransportError ? e.code : `other:${String(e)}`;
  }
}

describe("NodeFolderFs", () => {
  it("writes private files and directories and replaces a file by rename", async () => {
    const root = await tempRoot("fs");
    const fs = new NodeFolderFs(root);
    await fs.write("v/d/.000001.seg.a.tmp", bytes(1, 2, 3));
    await fs.rename("v/d/.000001.seg.a.tmp", "v/d/000001.seg");
    expect(await mode(join(root, "v"))).toBe(0o700);
    expect(await mode(join(root, "v", "d"))).toBe(0o700);
    expect(await mode(join(root, "v", "d", "000001.seg"))).toBe(0o600);
    await fs.write("v/d/.000001.seg.b.tmp", bytes(1, 2, 3, 4));
    await fs.rename("v/d/.000001.seg.b.tmp", "v/d/000001.seg");
    expect(await fs.list("v/d")).toEqual([{ name: "000001.seg", kind: "file", size: 4 }]);
    expect(await fs.list("v")).toEqual([{ name: "d", kind: "dir", size: 0 }]);
    expect([...((await fs.read("v/d/000001.seg", 2)) ?? [])]).toEqual([3, 4]);
    expect(await fs.read("v/d/000001.seg", 9)).toEqual(new Uint8Array(0));
    expect(await fs.read("v/d/000002.seg", 0)).toBeUndefined();
    expect(await fs.list("v/none")).toBeUndefined();
    await fs.remove("v/d/000001.seg");
    await fs.remove("v/d/000001.seg");
    expect(await fs.list("v/d")).toEqual([]);
  });

  it("keeps every path under the root", async () => {
    const fs = new NodeFolderFs(await tempRoot("escape"));
    for (const path of ["../x", "v/../../x", "v//x", "./x"]) {
      await expect(fs.write(path, bytes(1))).rejects.toThrow(RangeError);
      await expect(fs.read(path, 0)).rejects.toThrow(RangeError);
    }
    await expect(fs.write("", bytes(1))).rejects.toThrow(RangeError);
  });

  it("is unavailable when the root is missing or not a directory, and never creates it", async () => {
    const base = await tempRoot("gone");
    const root = join(base, "folder");
    const fs = new NodeFolderFs(root);
    expect(await errorCode(fs.list(""))).toBe("unavailable");
    expect(await errorCode(fs.read("v/d/000001.seg", 0))).toBe("unavailable");
    expect(await errorCode(fs.write("v/d/.x.tmp", bytes(1)))).toBe("unavailable");
    expect(await errorCode(fs.rename("a", "b"))).toBe("unavailable");
    expect(await errorCode(fs.remove("a"))).toBe("unavailable");
    expect(() => fs.watch("v", () => {})).toThrow(TransportError);
    await expect(stat(root)).rejects.toThrow();
    await writeFile(root, "not a folder");
    expect(await errorCode(fs.list(""))).toBe("unavailable");
  });

  it("is unavailable when permission on the folder is lost", async () => {
    const root = await tempRoot("perm");
    const fs = new NodeFolderFs(root);
    await fs.write("v/.x.tmp", bytes(1));
    await mkdir(join(root, "v", "locked"), { mode: 0o000 });
    expect(await errorCode(fs.write("v/locked/d/.x.tmp", bytes(1)))).toBe("unavailable");
    expect(await errorCode(fs.list("v/locked"))).toBe("unavailable");
  });

  it("reports changes below a watched directory", async () => {
    const root = await tempRoot("watch");
    const fs = new NodeFolderFs(root);
    let reported = false;
    const changed = new Promise<void>((resolve) => {
      const stop = fs.watch("v", () => {
        reported = true;
        stop();
        resolve();
      });
    });
    expect(await mode(join(root, "v"))).toBe(0o700);
    // A recursive watch starts asynchronously (FSEvents on macOS): a change made before the stream
    // is live is never reported. Repeat the change (a new file every 50 ms) until one is reported, so
    // the test ends on the report itself however long the watcher takes to start.
    for (let i = 0; !reported; i++) {
      await fs.write(`v/d/.x${i}.tmp`, bytes(1));
      await Promise.race([changed, new Promise((r) => setTimeout(r, 50))]);
    }
    await changed;
  });
});

const sodium = await crypto.loadNodeSodium();
const recovery = crypto.createRecoveryKey(sodium).publicKeys;

function carrierFor(fs: FolderFs, signers: TestSigners, device: DeviceId) {
  return createOwnLogCarrier({
    transport: new FolderTransport({ fs, owner: device }),
    codec: signers.codecFor(device),
    gate: signers.gateFor(device),
    device,
  });
}

describeCarrierContract({
  name: "own log over a shared folder (node-host NodeFolderFs)",
  async createMedium(vault) {
    const root = await tempRoot("shared");
    const locals = await tempRoot("locals");
    const fs = new NodeFolderFs(root);
    const signers = testSigners(sodium, crypto.createKeyring(sodium, recovery, vault));
    return {
      remoteFor: (device) => carrierFor(fs, signers, device),
      codecFor: (device) => signers.codecFor(device),
      gateFor: (device) => signers.gateFor(device),
      localFor: async (device) => {
        // A device's durable log copy (the daemon's `log/`); a restart reopens the same one.
        const dir = join(locals, device);
        await mkdir(dir, { recursive: true, mode: 0o700 });
        // No owner: the local log also holds the other devices' frames the engine copied in.
        return new FolderTransport({ fs: new NodeFolderFs(dir) });
      },
      dispose: async () => {
        await rm(root, { recursive: true, force: true });
        await rm(locals, { recursive: true, force: true });
      },
    };
  },
});

let seed = 1;

describeCarrierContract({
  name: "own log over an eventually synced folder (node-host NodeFolderFs replicas)",
  async createMedium(vault) {
    const root = await tempRoot("eventual");
    const sim = new CloudSim({ seed: seed++, partialRate: 0.3, conflictRate: 0.3, maxDelay: 4 });
    const signers = testSigners(sodium, crypto.createKeyring(sodium, recovery, vault));
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
      remoteFor: async (device) => carrierFor(await replica(device), signers, device),
      codecFor: (device) => signers.codecFor(device),
      gateFor: (device) => signers.gateFor(device),
      settle: async () => {
        for (let i = 0; i < 3; i++) await sim.churn();
        await sim.flush();
      },
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  },
});
