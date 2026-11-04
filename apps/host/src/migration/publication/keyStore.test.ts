import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireHostLock, hostRunPaths } from "@cashu/node-host";
import type { createProductionKeyStore } from "@cashu/node-host/keyring";
import { createTestKeyStore } from "@cashu/node-host/testing";
import { crypto } from "@cashu/sync";
import { expect, it } from "vitest";
import { createMigrationIdentitySet } from "./identity.js";
import { provisionMigrationKeyStore } from "./keyStore.js";

it("persists fresh ring and creator keys once under the held target lock", async () => {
  const sodium = await crypto.loadNodeSodium();
  const base = realpathSync(mkdtempSync(join(tmpdir(), "t44-test-")));
  const dataDir = join(base, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  mkdirSync(join(dataDir, "run"), { mode: 0o700 });
  const identities = createMigrationIdentitySet(sodium, ["synthetic"]);
  const osItems = new Map<string, Uint8Array>();
  const service = `cashu-next-test.${randomBytes(16).toString("hex")}`;
  const keyring = {
    async get(s: string, account: string) {
      return osItems.get(`${s}/${account}`)?.slice() ?? null;
    },
    async set(s: string, account: string, value: Uint8Array) {
      osItems.set(`${s}/${account}`, value.slice());
    },
  };
  const makeKeyStore: typeof createProductionKeyStore = (input) =>
    createTestKeyStore({ ...input, service, keyring });
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("test lock unavailable");
  try {
    const input = { dataDir, identities, lock, sodium, makeKeyStore };
    await provisionMigrationKeyStore(input);
    expect(osItems.size).toBe(1);
    await expect(provisionMigrationKeyStore(input)).rejects.toThrow("identity_invalid");
  } finally {
    lock.release();
    identities.wipe();
    rmSync(base, { recursive: true, force: true });
  }
});
