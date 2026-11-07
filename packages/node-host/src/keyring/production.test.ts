import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { crypto } from "@cashu/sync";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHostLock } from "../host/lock.js";
import { hostRunPaths } from "../host/paths.js";
import type { OsKeyringPort } from "./native.js";
import {
  createProductionKeyStore,
  createTestKeyStore,
  createTestMigrationKek,
} from "./production.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const sodium = await crypto.loadNodeSodium();
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "t44-test-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const run = join(dataDir, "run");
  mkdirSync(run, { mode: 0o700 });
  const lock = acquireHostLock(hostRunPaths(dataDir).lockPath);
  if (!lock) throw new Error("synthetic lock missing");
  const items = new Map<string, Uint8Array>();
  let calls = 0;
  const keyring: OsKeyringPort = {
    async get(service, account) {
      calls++;
      return items.get(`${service}/${account}`)?.slice() ?? null;
    },
    async set(service, account, value) {
      calls++;
      items.set(`${service}/${account}`, value.slice());
    },
  };
  const service = `cashu-next-test.${randomBytes(16).toString("hex")}`;
  const name = crypto.keyringName("a1".repeat(16));
  const second = crypto.deviceIdentityName("b2".repeat(16));
  const provision = {
    lock,
    assertPending() {
      if (!lock.held) throw new Error("synthetic pending record revoked");
    },
  };
  const make = (purpose: "open" | "provision", names = new Set([name, second])) =>
    createTestKeyStore({
      dataDir,
      service,
      keyring,
      sodium,
      purpose,
      authorizedNames: names,
      ...(purpose === "provision" ? { provision } : {}),
    });
  return { root, dataDir, service, name, second, make, items, keyring, lock, calls: () => calls };
}
function blobPath(f: ReturnType<typeof fixture>, name: string) {
  return join(f.dataDir, "vault-secrets", "v1", `${name}.bin`);
}
function onlyItem(f: ReturnType<typeof fixture>): [string, Uint8Array] {
  const item = [...f.items.entries()][0];
  if (!item) throw new Error("synthetic KEK missing");
  return item;
}

describe("isolated Node OS KeyStore", () => {
  it("does not create a KEK or blob on open and refuses unknown names before OS calls", async () => {
    const f = fixture();
    const store = f.make("open");
    expect(await store.get(f.name)).toBeNull();
    expect(f.calls()).toBe(0);
    await expect(store.get("../escape")).rejects.toMatchObject({ code: "bad_key_name" });
    await expect(store.get(crypto.keyringName("c3".repeat(16)))).rejects.toMatchObject({
      code: "bad_key_name",
    });
    expect(f.calls()).toBe(0);
    expect(readdirSync(f.dataDir)).toEqual(["run"]);
    f.lock.release();
  });
  it("provisions once; fresh open reads; open set rotates authenticated blob only", async () => {
    const f = fixture();
    const first = f.make("provision");
    await first.set(f.name, Uint8Array.of(1, 2, 3));
    await first.set(f.second, Uint8Array.of(4, 5));
    expect(f.items.size).toBe(1);
    const open = f.make("open");
    expect(await open.get(f.name)).toEqual(Uint8Array.of(1, 2, 3));
    await open.set(f.name, Uint8Array.of(9));
    expect(await open.get(f.name)).toEqual(Uint8Array.of(9));
    await expect(
      open.set(crypto.keyringName("c3".repeat(16)), Uint8Array.of(1)),
    ).rejects.toMatchObject({ code: "bad_key_name" });
    await expect(open.delete(f.name)).rejects.toMatchObject({ code: "keystore_unavailable" });
    await first.delete(f.name);
    expect(await open.get(f.name)).toBeNull();
    expect(await open.get(f.second)).toEqual(Uint8Array.of(4, 5));
    expect(f.items.size).toBe(1);
    f.lock.release();
  });
  it("rejects absent or wrong KEK, swapped name blobs, and malformed ciphertext", async () => {
    const f = fixture();
    const provision = f.make("provision");
    await provision.set(f.name, Uint8Array.of(7));
    await provision.set(f.second, Uint8Array.of(8));
    const open = f.make("open");
    const [item, good] = onlyItem(f);
    f.items.delete(item);
    await expect(open.get(f.name)).rejects.toMatchObject({ code: "keystore_unavailable" });
    f.items.set(item, randomBytes(32));
    await expect(open.get(f.name)).rejects.toMatchObject({ code: "keystore_corrupt" });
    f.items.set(item, good);
    copyFileSync(blobPath(f, f.name), blobPath(f, f.second));
    await expect(open.get(f.second)).rejects.toMatchObject({ code: "keystore_corrupt" });
    writeFileSync(blobPath(f, f.name), Uint8Array.of(2));
    await expect(open.get(f.name)).rejects.toMatchObject({ code: "keystore_corrupt" });
    f.lock.release();
  });
  it("rejects a missing KEK with existing blob and refuses unsafe file permissions", async () => {
    const f = fixture();
    await f.make("provision").set(f.name, Uint8Array.of(1));
    const [item] = onlyItem(f);
    f.items.delete(item);
    await expect(f.make("provision").set(f.second, Uint8Array.of(2))).rejects.toMatchObject({
      code: "keystore_unavailable",
    });
    chmodSync(blobPath(f, f.name), 0o644);
    await expect(f.make("open").get(f.name)).rejects.toMatchObject({ code: "keystore_corrupt" });
    f.lock.release();
  });
  it("binds a blob to its exact test service", async () => {
    const first = fixture();
    const second = fixture();
    await first.make("provision").set(first.name, Uint8Array.of(5));
    mkdirSync(join(second.dataDir, "vault-secrets", "v1"), { recursive: true, mode: 0o700 });
    copyFileSync(blobPath(first, first.name), blobPath(second, second.name));
    await expect(second.make("open").get(second.name)).rejects.toMatchObject({
      code: "keystore_unavailable",
    });
    first.lock.release();
    second.lock.release();
  });
  it("refuses a symlinked blob and a released provisioning lock", async () => {
    const f = fixture();
    await f.make("provision").set(f.name, Uint8Array.of(5));
    const path = blobPath(f, f.name);
    unlinkSync(path);
    symlinkSync(blobPath(f, f.second), path);
    await expect(f.make("open").get(f.name)).rejects.toMatchObject({
      code: "keystore_unavailable",
    });
    const store = f.make("provision");
    f.lock.release();
    await expect(store.set(f.second, Uint8Array.of(2))).rejects.toMatchObject({
      code: "keystore_unavailable",
    });
  });
  it("rejects a FIFO blob without blocking the process", () => {
    const f = fixture();
    const parent = join(f.dataDir, "vault-secrets");
    const version = join(parent, "v1");
    mkdirSync(parent, { mode: 0o700 });
    mkdirSync(version, { mode: 0o700 });
    execFileSync("/usr/bin/mkfifo", [blobPath(f, f.name)]);
    const source = pathToFileURL(resolve("src/keyring/files.ts")).href;
    const code = `
      const { PrivateBlobFiles } = await import(${JSON.stringify(source)});
      const files = new PrivateBlobFiles(${JSON.stringify(f.dataDir)}, false);
      try {
        await files.read(${JSON.stringify(f.name)});
        process.exit(2);
      } catch (error) {
        if (error?.code !== "keystore_corrupt") process.exit(3);
      }
    `;
    execFileSync(
      process.execPath,
      ["--import", resolve("../../tools/node-ts/resolveTs.ts"), "--input-type=module", "-e", code],
      { timeout: 2_000, cwd: process.cwd() },
    );
    f.lock.release();
  });
  it("rejects an invalid test namespace before a native port call", () => {
    const f = fixture();
    expect(() =>
      createTestKeyStore({
        dataDir: f.dataDir,
        service: "cashu.vault.v1.fake",
        keyring: f.keyring,
        sodium,
        purpose: "open",
        authorizedNames: new Set([f.name]),
      }),
    ).toThrow();
    expect(f.calls()).toBe(0);
    f.lock.release();
  });
  it("provision refuses overwrite and exact absent delete is idempotent", async () => {
    const f = fixture();
    const provision = f.make("provision");
    await provision.set(f.name, Uint8Array.of(1));
    await expect(provision.set(f.name, Uint8Array.of(2))).rejects.toMatchObject({
      code: "keystore_unavailable",
    });
    expect(await f.make("open").get(f.name)).toEqual(Uint8Array.of(1));
    await provision.delete(f.second);
    expect(f.items.size).toBe(1);
    f.lock.release();
  });
  it("serializes first KEK creation across factories sharing the namespace", async () => {
    const f = fixture();
    let writes = 0;
    const originalSet = f.keyring.set.bind(f.keyring);
    f.keyring.set = async (...args) => {
      writes++;
      await Promise.resolve();
      await originalSet(...args);
    };
    const first = f.make("provision");
    const second = f.make("provision");
    await Promise.all([
      first.set(f.name, Uint8Array.of(1)),
      second.set(f.second, Uint8Array.of(2)),
    ]);
    expect(writes).toBe(1);
    const open = f.make("open");
    expect(await open.get(f.name)).toEqual(Uint8Array.of(1));
    expect(await open.get(f.second)).toEqual(Uint8Array.of(2));
    f.lock.release();
  });
  it("stops provisioning when the host lock is released during native get", async () => {
    const f = fixture();
    let signalEntered: () => void = () => undefined;
    let releaseGet: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseGet = resolve;
    });
    const originalGet = f.keyring.get.bind(f.keyring);
    f.keyring.get = async (...args) => {
      signalEntered();
      await gate;
      return originalGet(...args);
    };
    const pending = f.make("provision").set(f.name, Uint8Array.of(1));
    await entered;
    f.lock.release();
    releaseGet();
    await expect(pending).rejects.toMatchObject({ code: "keystore_unavailable" });
    expect(f.items.size).toBe(0);
    expect(readdirSync(f.dataDir)).toEqual(["run"]);
  });
  it("stops before blob creation when pending authority is revoked during native set", async () => {
    const f = fixture();
    let active = true;
    let signalEntered: () => void = () => undefined;
    let releaseSet: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseSet = resolve;
    });
    const originalSet = f.keyring.set.bind(f.keyring);
    f.keyring.set = async (...args) => {
      await originalSet(...args);
      signalEntered();
      await gate;
    };
    const store = createTestKeyStore({
      dataDir: f.dataDir,
      service: f.service,
      keyring: f.keyring,
      sodium,
      purpose: "provision",
      authorizedNames: new Set([f.name]),
      provision: {
        lock: f.lock,
        assertPending() {
          if (!active) throw new Error("revoked synthetic pending record");
        },
      },
    });
    const pending = store.set(f.name, Uint8Array.of(1));
    await entered;
    active = false;
    releaseSet();
    await expect(pending).rejects.toMatchObject({ code: "keystore_unavailable" });
    expect(f.items.size).toBe(1);
    expect(readdirSync(f.dataDir)).toEqual(["run"]);
    f.lock.release();
  });
  it("detaches set bytes and freezes purpose and admitted names before its queue turn", async () => {
    const f = fixture();
    const names = new Set([f.name, f.second]);
    const input = {
      dataDir: f.dataDir,
      service: f.service,
      keyring: f.keyring,
      sodium,
      purpose: "provision" as "open" | "provision",
      authorizedNames: names,
      provision: {
        lock: f.lock,
        assertPending() {
          if (!f.lock.held) throw new Error("revoked");
        },
      },
    };
    const store = createTestKeyStore(input);
    const bytes = Buffer.from([7]);
    const writing = store.set(f.name, bytes);
    bytes[0] = 9;
    input.purpose = "open";
    names.clear();
    await writing;
    expect(await f.make("open").get(f.name)).toEqual(Uint8Array.of(7));
    await expect(store.set(f.name, Uint8Array.of(2))).rejects.toMatchObject({
      code: "keystore_unavailable",
    });
    f.lock.release();
  });
  it("wipes a malformed native KEK and refuses a different valid first-write readback", async () => {
    const malformed = fixture();
    const short = Uint8Array.of(1, 2);
    malformed.keyring.get = async () => short;
    await expect(
      malformed.make("provision").set(malformed.name, Uint8Array.of(1)),
    ).rejects.toMatchObject({ code: "keystore_corrupt" });
    expect(short).toEqual(Uint8Array.of(0, 0));
    malformed.lock.release();

    const changed = fixture();
    changed.keyring.set = async (service, account) => {
      changed.items.set(
        `${service}/${account}`,
        Uint8Array.from({ length: 32 }, () => 0),
      );
    };
    await expect(
      changed.make("provision").set(changed.name, Uint8Array.of(1)),
    ).rejects.toMatchObject({ code: "keystore_corrupt" });
    expect(readdirSync(changed.dataDir)).toEqual(["run"]);
    changed.lock.release();
  });
  it("scopes a migration's staged tree to its data dir's namespace, and nothing else", async () => {
    const f = fixture();
    const staged = join(f.dataDir, ".migration-20270101T000000000Z", "native");
    mkdirSync(join(staged, "run"), { recursive: true, mode: 0o700 });
    const lock = acquireHostLock(hostRunPaths(staged).lockPath);
    if (!lock) throw new Error("synthetic staged lock missing");
    const names = new Set([f.name]);
    const provision = createTestKeyStore({
      dataDir: staged,
      scopeDir: f.dataDir,
      service: f.service,
      keyring: f.keyring,
      sodium,
      purpose: "provision",
      authorizedNames: names,
      provision: { lock, assertPending() {} },
    });
    await provision.set(f.name, Uint8Array.of(5));
    // The blob is the staged tree's own file; the KEK is the data dir's.
    expect(readdirSync(join(staged, "vault-secrets", "v1"))).toEqual([`${f.name}.bin`]);
    expect([...f.items.keys()]).toEqual([`${f.service}/cashu.keystore.kek`]);
    lock.release();
    const open = (dataDir: string, scopeDir?: string) =>
      createTestKeyStore({
        dataDir,
        ...(scopeDir === undefined ? {} : { scopeDir }),
        service: f.service,
        keyring: f.keyring,
        sodium,
        purpose: "open",
        authorizedNames: names,
      });
    for (const [dataDir, scopeDir] of [
      [f.dataDir, f.dataDir],
      [join(f.dataDir, "run"), f.dataDir],
      [join(f.dataDir, ".migration-"), f.dataDir],
      [staged, join(f.dataDir, "run")],
      [staged, `${f.dataDir}/../data`],
    ] as const)
      expect(() => open(dataDir, scopeDir)).toThrow();
    for (const [dataDir, scopeDir] of [
      [f.dataDir, f.dataDir],
      [staged, join(f.dataDir, "run")],
    ] as const)
      expect(() =>
        createProductionKeyStore({
          dataDir,
          scopeDir,
          sodium,
          purpose: "open",
          authorizedNames: names,
        }),
      ).toThrow();
    expect(await open(staged, f.dataDir).get(f.name)).toEqual(Uint8Array.of(5));
    f.lock.release();
  });
  it("manages a migration's KEK in the exact test namespace only", async () => {
    const f = fixture();
    const deletable = {
      ...f.keyring,
      async delete(service: string, account: string) {
        f.items.delete(`${service}/${account}`);
      },
    };
    expect(() =>
      createTestMigrationKek({
        dataDir: f.dataDir,
        service: "cashu.vault.v1.fake",
        keyring: deletable,
      }),
    ).toThrow();
    expect(() =>
      createTestMigrationKek({ dataDir: f.root, service: f.service, keyring: deletable }),
    ).toThrow();
    const kek = createTestMigrationKek({
      dataDir: f.dataDir,
      service: f.service,
      keyring: deletable,
    });
    expect(await kek.present()).toBe(false);
    await kek.remove();
    await f.make("provision").set(f.name, Uint8Array.of(1));
    expect(await kek.present()).toBe(true);
    await kek.remove();
    expect(await kek.present()).toBe(false);
    expect(f.items.size).toBe(0);
    f.lock.release();
  });
});
