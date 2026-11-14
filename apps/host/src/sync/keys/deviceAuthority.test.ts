// The host half of device authority: the inventory locator checks around the portable loader
// (packages/store/src/sync/deviceAuthority.test.ts holds the key, certificate and replay checks).
// Synthetic data only.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import { SqlProvenanceStore } from "@cashu/store/sync";
import { crypto } from "@cashu/sync";
import { InMemoryKeyStore } from "@cashu/sync/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadDeviceAuthority,
  type NativeVaultInventoryEntry,
  validateNativeVaultInventorySet,
} from "./deviceAuthority.js";

const sodium = await crypto.loadNodeSodium();
const NOW = Date.UTC(2026, 10, 3, 12);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cashu-authority-test-")));
  roots.push(dir);
  return dir;
}

async function creator() {
  const dataDir = root();
  const store = new InMemoryKeyStore();
  const identity = crypto.createDeviceIdentity(sodium);
  const recovery = crypto.recoveryIdentity(sodium, crypto.createRecoveryKey(sodium).phrase);
  const created = crypto.createVaultWithRecovery(sodium, recovery, identity);
  const entry: NativeVaultInventoryEntry = {
    vaultId: created.ring.vaultId,
    deviceId: identity.deviceId,
    vaultRoot: join(dataDir, created.ring.vaultId),
    state: "ready",
    enrollment: "creator",
  };
  mkdirSync(entry.vaultRoot);
  await crypto.saveKeyring(store, created.ring);
  await crypto.saveDeviceIdentity(store, identity);
  const dbPath = join(entry.vaultRoot, "authority.db");
  const driver = openNodeSqlite(dbPath);
  const provenance = SqlProvenanceStore.open(driver, created.ring, "new");
  const first = created.ring.active;
  provenance.put({
    kid: first.kid,
    generation: first.generation,
    epoch: first.epoch,
    sender: identity.deviceId,
    recipients: null,
    source: "own",
    receivedAt: NOW,
  });
  const input = {
    entry,
    dataDir,
    keyStore: store,
    sodium,
    provenance,
    clock: () => NOW,
    bootstrapCertificates: [created.creatorCertificate],
  };
  return { created, recovery, identity, store, driver, dbPath, input };
}

describe("device authority foundation", () => {
  it("rejects duplicate inventory and a collision with the old synthetic store root", async () => {
    const c = await creator();
    expect(() => validateNativeVaultInventorySet([c.input.entry], c.input.dataDir)).not.toThrow();
    expect(() =>
      validateNativeVaultInventorySet([c.input.entry, c.input.entry], c.input.dataDir),
    ).toThrow("invalid_inventory");
    mkdirSync(join(c.input.dataDir, "stores"));
    expect(() =>
      validateNativeVaultInventorySet(
        [{ ...c.input.entry, vaultRoot: join(c.input.dataDir, "stores") }],
        c.input.dataDir,
      ),
    ).toThrow("invalid_inventory");
    c.driver.close();
  });
  it("refuses noncanonical and symlinked inventory roots", async () => {
    const c = await creator();
    const alias = join(c.input.dataDir, "alias");
    symlinkSync(c.input.entry.vaultRoot, alias);
    await expect(
      loadDeviceAuthority({
        ...c.input,
        entry: { ...c.input.entry, vaultRoot: alias },
      }),
    ).rejects.toThrow("invalid_inventory");
    await expect(
      loadDeviceAuthority({
        ...c.input,
        entry: { ...c.input.entry, vaultRoot: `${c.input.entry.vaultRoot}/../alias` },
      }),
    ).rejects.toThrow("invalid_inventory");
    c.driver.close();
  });

  it("keeps inventory and certificate bytes fixed across asynchronous key reads", async () => {
    const c = await creator();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const delayed: crypto.KeyStore = {
      get: async (name) => {
        if (first) {
          first = false;
          await held;
        }
        return c.store.get(name);
      },
      set: (name, value) => c.store.set(name, value),
      delete: (name) => c.store.delete(name),
    };
    const mutable = { ...c.input.entry };
    const certificate = c.created.creatorCertificate.slice();
    const loaded = loadDeviceAuthority({
      ...c.input,
      entry: mutable,
      keyStore: delayed,
      bootstrapCertificates: [certificate],
    });
    mutable.deviceId = "f".repeat(32);
    certificate.fill(0);
    release();
    const candidate = await loaded;
    expect(candidate.entry.deviceId).toBe(c.identity.deviceId);
    candidate.close();
    c.driver.close();
  });
});
