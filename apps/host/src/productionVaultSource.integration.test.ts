import { randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
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
import { createTestKeyStore, type OsKeyringPort } from "@cashu/node-host/testing";
import { crypto } from "@cashu/sync";
import { afterEach, expect, it } from "vitest";
import { startLocalHost } from "./host.js";
import { ProductionVaultSourceFactory } from "./productionVaultSource.js";
import { storeClient } from "./testing/harness.js";
import { nativeVaultFixture } from "./testing/nativeVaultFixture.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("opens an enrolled encrypted vault through the sealed-file test KeyStore, appends and reopens", async () => {
  const original = await nativeVaultFixture();
  try {
    const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "t44-test-")));
    roots.push(root);
    const dataDir = join(root, "data");
    const home = join(root, "home");
    mkdirSync(dataDir, { mode: 0o700 });
    mkdirSync(home, { mode: 0o700 });
    mkdirSync(join(dataDir, "run"), { mode: 0o700 });
    mkdirSync(join(dataDir, "vaults"), { mode: 0o700 });
    const entry = original.vaultSource.provider.inventory[0];
    if (!entry) throw new Error("missing synthetic entry");
    const vaultRoot = join(dataDir, "vaults", entry.vaultId);
    cpSync(entry.vaultRoot, vaultRoot, { recursive: true });
    chmodSync(vaultRoot, 0o700);
    const certs = await original.vaultSource.provider.bootstrapCertificates();
    writeFileSync(
      join(vaultRoot, "certificates.v1.json"),
      JSON.stringify({
        format: 1,
        vaultId: entry.vaultId,
        deviceId: entry.deviceId,
        certificates: certs.map((cert) => Buffer.from(cert).toString("base64url")),
      }),
      { mode: 0o600 },
    );
    const names = new Set([
      crypto.keyringName(entry.vaultId),
      crypto.deviceIdentityName(entry.deviceId),
    ]);
    const items = new Map<string, Uint8Array>();
    const keyring: OsKeyringPort = {
      async get(service, account) {
        return items.get(`${service}/${account}`)?.slice() ?? null;
      },
      async set(service, account, value) {
        items.set(`${service}/${account}`, value.slice());
      },
    };
    const service = `cashu-next-test.${randomBytes(16).toString("hex")}`;
    const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
    if (!lock) throw new Error("synthetic host lock unavailable");
    const pendingPath = join(dataDir, "pending-test.json");
    writeFileSync(
      pendingPath,
      JSON.stringify({ vaultId: entry.vaultId, deviceId: entry.deviceId }),
      {
        mode: 0o600,
      },
    );
    try {
      const provision = createTestKeyStore({
        dataDir,
        service,
        keyring,
        sodium: original.vaultSource.provider.sodium,
        purpose: "provision",
        authorizedNames: names,
        provision: {
          lock,
          assertPending() {
            if (!lock.held) throw new Error("lost test lock");
            const pending = JSON.parse(readFileSync(pendingPath, "utf8")) as {
              vaultId?: string;
              deviceId?: string;
            };
            if (pending.vaultId !== entry.vaultId || pending.deviceId !== entry.deviceId)
              throw new Error("changed test pending record");
          },
        },
      });
      for (const name of names) {
        const value = await original.vaultSource.provider.keyStore.get(name);
        if (!value) throw new Error("missing synthetic secret");
        await provision.set(name, value);
        value.fill(0);
      }
    } finally {
      lock.release();
      rmSync(pendingPath);
    }
    const nativeDir = join(dataDir, "native", "v1");
    mkdirSync(nativeDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(nativeDir, "inventory.json"),
      JSON.stringify({
        format: 1,
        vaults: [
          {
            vaultId: entry.vaultId,
            deviceId: entry.deviceId,
            state: "ready",
            enrollment: "creator",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const makeFactory = () =>
      new ProductionVaultSourceFactory(dataDir, (input) =>
        createTestKeyStore({ ...input, service, keyring }),
      );
    const open = () =>
      startLocalHost({
        dataDir,
        home,
        build: "test",
        launcher: false,
        python: null,
        vaultSource: { kind: "native-production", factory: makeFactory() },
      });
    const first = await open();
    try {
      const client = await storeClient(dataDir);
      expect(client.vaults).toEqual([entry.vaultId]);
      expect(
        await client.run(
          "core.renameProfile",
          { name: "Synthetic changed" },
          { vault: entry.vaultId },
        ),
      ).toEqual({
        ok: true,
        value: null,
      });
      client.close();
    } finally {
      await first.stop();
    }
    const second = await open();
    try {
      const client = await storeClient(dataDir);
      const profile = await client.subscribe("core.profile", entry.vaultId);
      expect(profile.first).toMatchObject({ name: "Synthetic changed" });
      client.close();
    } finally {
      await second.stop();
    }
    const blobPath = join(
      dataDir,
      "vault-secrets",
      "v1",
      `${crypto.keyringName(entry.vaultId)}.bin`,
    );
    expect(existsSync(blobPath)).toBe(true);
    const damaged = readFileSync(blobPath);
    damaged[damaged.length - 1] = (damaged[damaged.length - 1] ?? 0) ^ 1;
    writeFileSync(blobPath, damaged);
    await expect(open()).rejects.toMatchObject({ code: "keystore_corrupt" });
  } finally {
    original.cleanup();
  }
});
