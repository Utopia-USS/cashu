import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import { publishCheckedImportBlob } from "@cashu/store/investments/services";
import { crypto } from "@cashu/sync";
import { expect, it } from "vitest";
import { NativeBlobPublication } from "./nativeBlobs.js";

it("publishes a vault-bound encrypted import blob and reads it after reopening", async () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), "t44-test-")));
  const sodium = await crypto.loadNodeSodium();
  const recovery = crypto.createRecoveryKey(sodium);
  const ring = crypto.createKeyring(sodium, recovery.publicKeys);
  const vaultRoot = join(dataDir, "vaults", ring.vaultId);
  mkdirSync(vaultRoot, { recursive: true, mode: 0o700 });
  mkdirSync(join(dataDir, "run"), { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("synthetic lock unavailable");
  try {
    const otherRoot = join(dataDir, "other");
    mkdirSync(join(otherRoot, "run"), { recursive: true, mode: 0o700 });
    const wrongLock = acquireHostLock(hostRunPaths(otherRoot).lockPath);
    if (!wrongLock) throw new Error("synthetic wrong-root lock unavailable");
    try {
      expect(
        () =>
          new NativeBlobPublication({
            dataDir,
            vault: ring.vaultId,
            lock: wrongLock,
            sodium,
            ring,
          }),
      ).toThrow();
    } finally {
      wrongLock.release();
    }
    const content = new Uint8Array(randomBytes(97));
    const first = new NativeBlobPublication({ dataDir, vault: ring.vaultId, lock, sodium, ring });
    const checked = await publishCheckedImportBlob(first, ring.vaultId, {
      name: "statement.csv",
      content,
    });
    first.close();
    const path = join(vaultRoot, "blobs", `${checked.blob.sha256}.csv.enc`);
    expect(readFileSync(path)).not.toEqual(content);
    const reopened = new NativeBlobPublication({
      dataDir,
      vault: ring.vaultId,
      lock,
      sodium,
      ring,
    });
    expect(await reopened.read(ring.vaultId, checked.blob, content.length)).toEqual(content);
    await expect(reopened.read("00".repeat(16), checked.blob, content.length)).rejects.toThrow();
    await expect(reopened.read(ring.vaultId, checked.blob, content.length - 1)).rejects.toThrow();
    expect((await reopened.put(content, "csv")).sha256).toBe(checked.blob.sha256);
    reopened.close();
    const altered = readFileSync(path);
    altered[altered.length - 1] = (altered.at(-1) ?? 0) ^ 1;
    writeFileSync(path, altered);
    chmodSync(path, 0o600);
    const refused = new NativeBlobPublication({ dataDir, vault: ring.vaultId, lock, sodium, ring });
    await expect(refused.read(ring.vaultId, checked.blob, content.length)).rejects.toThrow();
    await expect(refused.publish(content, checked.blob)).rejects.toThrow();
    if (process.platform !== "win32") {
      rmSync(path);
      execFileSync("mkfifo", [path]);
      await expect(refused.read(ring.vaultId, checked.blob, content.length)).rejects.toThrow();
    }
  } finally {
    ring.wipe();
    lock.release();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
