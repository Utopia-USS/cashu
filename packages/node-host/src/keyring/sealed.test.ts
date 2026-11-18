// The Windows storage of large secrets, run on any OS by injecting the platform: values sealed into
// private files under the data dir, only a 32-byte key in a synthetic keyring that enforces the
// Credential Manager's 2560-byte limit. macOS and Linux keep the keyring port as is. Synthetic data,
// temp dirs only; never a real keychain item.
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crypto } from "@cashu/sync";
import { afterEach, describe, expect, it } from "vitest";
import { hasPrivateMode } from "../host/privateFs.js";
import { linkDir } from "../testing/links.js";
import { type OsKeyringPort, osKeyringFits } from "./native.js";
import { largeSecretKeyring, SEALED_KEK_ACCOUNT, sealedBlobName } from "./sealed.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A synthetic Credential Manager: refuses a secret over 2560 bytes, as Windows does. */
function credentialManager() {
  const items = new Map<string, Uint8Array>();
  const keyring: OsKeyringPort = {
    async get(service, account) {
      return items.get(`${service}/${account}`)?.slice() ?? null;
    },
    async set(service, account, value) {
      if (!osKeyringFits(value.length, "win32"))
        throw new crypto.CryptoError("keystore_unavailable");
      items.set(`${service}/${account}`, value.slice());
    },
  };
  return { items, keyring };
}

function fixture() {
  const root = mkdtempSync(join(realpathSync.native(tmpdir()), "cashu-sealed-test-"));
  roots.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { mode: 0o700 });
  const os = credentialManager();
  const service = `cashu-next-banking-test.${randomBytes(16).toString("hex")}`;
  const port = largeSecretKeyring(dataDir, "banking-secrets", {
    platform: "win32",
    keyring: os.keyring,
  });
  const blobPath = (account: string) =>
    join(dataDir, "banking-secrets", "v1", `${sealedBlobName(service, account)}.bin`);
  return { dataDir, service, port, blobPath, ...os };
}

const synthetic = (bytes: number) => new Uint8Array(randomBytes(bytes));

describe("large secret keyring", () => {
  it("is the OS keyring itself on macOS and Linux", () => {
    const { keyring } = credentialManager();
    for (const platform of ["darwin", "linux"] as const) {
      expect(largeSecretKeyring("/unused", "banking-secrets", { platform, keyring })).toBe(keyring);
    }
  });

  it("seals a value over 2560 bytes into a private file, with only a 32-byte key in the keyring", async () => {
    const f = fixture();
    const value = synthetic(8 * 1024);
    await f.port.set(f.service, "credentials.a", value);
    expect([...f.items.keys()]).toEqual([`${f.service}/${SEALED_KEK_ACCOUNT}`]);
    expect(f.items.get(`${f.service}/${SEALED_KEK_ACCOUNT}`)?.length).toBe(32);
    const path = f.blobPath("credentials.a");
    expect(lstatSync(path).isFile()).toBe(true);
    expect(hasPrivateMode(lstatSync(path), 0o600)).toBe(true);
    expect(readFileSync(path).indexOf(Buffer.from(value.subarray(0, 64)))).toBe(-1);
    expect(await f.port.get(f.service, "credentials.a")).toEqual(value);
    expect(await f.port.get(f.service, "sessions.a")).toBeNull();
  });

  it("clears a value by removing its blob and keeps accounts and services apart", async () => {
    const f = fixture();
    await f.port.set(f.service, "a", synthetic(10));
    await f.port.set(f.service, "b", Uint8Array.of(7));
    await f.port.set(f.service, "a", new Uint8Array());
    expect(existsSync(f.blobPath("a"))).toBe(false);
    expect(await f.port.get(f.service, "a")).toBeNull();
    expect(await f.port.get(f.service, "b")).toEqual(Uint8Array.of(7));
    expect(await f.port.get(`${f.service}x`, "b")).toBeNull();
  });

  it("creates one key for concurrent first writes", async () => {
    const f = fixture();
    const values = Array.from({ length: 6 }, (_, i) => synthetic(3000 + i));
    await Promise.all(values.map((v, i) => f.port.set(f.service, `acc.${i}`, v)));
    expect(f.items.size).toBe(1);
    for (const [i, v] of values.entries())
      expect(await f.port.get(f.service, `acc.${i}`)).toEqual(v);
  });

  it("refuses blobs whose key is gone and never makes a new key over them", async () => {
    const f = fixture();
    await f.port.set(f.service, "a", synthetic(40));
    f.items.clear();
    await expect(f.port.get(f.service, "a")).rejects.toMatchObject({
      code: "keystore_unavailable",
    });
    await expect(f.port.set(f.service, "b", synthetic(40))).rejects.toMatchObject({
      code: "keystore_unavailable",
    });
    expect(f.items.size).toBe(0);
  });

  it("refuses a tampered blob and a blob moved to another account", async () => {
    const f = fixture();
    await f.port.set(f.service, "a", synthetic(40));
    await f.port.set(f.service, "b", synthetic(40));
    copyFileSync(f.blobPath("a"), f.blobPath("b"));
    await expect(f.port.get(f.service, "b")).rejects.toMatchObject({ code: "keystore_corrupt" });
    const bytes = readFileSync(f.blobPath("a"));
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    writeFileSync(f.blobPath("a"), bytes);
    await expect(f.port.get(f.service, "a")).rejects.toMatchObject({ code: "keystore_corrupt" });
  });

  // The sealed files read through PrivateBlobFiles: a dangling link (a junction on Windows) where a
  // blob belongs is refused, never "no value", before and after a value was stored.
  it("refuses a dangling link in place of a blob instead of reading it as no value", async () => {
    const f = fixture();
    await f.port.set(f.service, "a", synthetic(40));
    await f.port.set(f.service, "b", synthetic(40));
    rmSync(f.blobPath("a"));
    linkDir(join(f.dataDir, "missing"), f.blobPath("a"));
    linkDir(join(f.dataDir, "missing"), f.blobPath("c"));
    for (const account of ["a", "c"]) {
      await expect(f.port.get(f.service, account)).rejects.toMatchObject({
        code: "keystore_unavailable",
      });
    }
  });

  it("keeps each kind in its own directory, beside (never inside) the vault keys", async () => {
    const f = fixture();
    const connectors = largeSecretKeyring(f.dataDir, "connector-secrets", {
      platform: "win32",
      keyring: f.keyring,
    });
    await f.port.set(f.service, "a", synthetic(10));
    await connectors.set(`${f.service}c`, "a", synthetic(10));
    expect(readdirSync(f.dataDir).sort()).toEqual(["banking-secrets", "connector-secrets"]);
  });
});
