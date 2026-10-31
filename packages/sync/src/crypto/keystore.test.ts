import { describe, expect, it } from "vitest";
import { fromBase64, toBase64, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { openFrame, sealFrame } from "./frame.js";
import { createDeviceIdentity } from "./identity.js";
import { rotateKeyring } from "./keys.js";
import {
  type BlobFiles,
  createSafeStorageKeyStore,
  createSecureStoreKeyStore,
  deviceIdentityName,
  type KeyStore,
  keyringName,
  loadDeviceIdentity,
  loadKeyring,
  type SafeStorageLike,
  type SecureStoreLike,
  saveDeviceIdentity,
  saveKeyring,
} from "./keystore.js";
import { InMemoryKeyStore } from "./testing.js";
import { ctx, newRing, samplePlain, sodium } from "./testkit.js";

// Fake safeStorage: reversible but not identity, so a test can tell stored blobs are not the raw value.
function fakeSafeStorage(backend = "keychain", available = true): SafeStorageLike {
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (s) => utf8(`enc:${[...s].reverse().join("")}`),
    decryptString: (b) => [...new TextDecoder().decode(b).slice(4)].reverse().join(""),
  };
}

function memoryFiles(): BlobFiles & { blobs: Map<string, Uint8Array> } {
  const blobs = new Map<string, Uint8Array>();
  return {
    blobs,
    read: async (n) => blobs.get(n) ?? null,
    write: async (n, v) => void blobs.set(n, v),
    remove: async (n) => void blobs.delete(n),
  };
}

function fakeSecureStore(): SecureStoreLike & {
  items: Map<string, string>;
  accessible: unknown[];
} {
  const items = new Map<string, string>();
  const accessible: unknown[] = [];
  return {
    items,
    accessible,
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 7,
    getItemAsync: async (k, o) => {
      accessible.push(o?.keychainAccessible);
      return items.get(k) ?? null;
    },
    setItemAsync: async (k, v, o) => {
      accessible.push(o?.keychainAccessible);
      items.set(k, v);
    },
    deleteItemAsync: async (k, o) => {
      accessible.push(o?.keychainAccessible);
      items.delete(k);
    },
  };
}

async function roundtrip(store: KeyStore) {
  const ring = newRing();
  const c = ctx(ring.vaultId);
  const frame = sealFrame(sodium, ring, samplePlain(), c);
  await saveKeyring(store, ring);
  const loaded = await loadKeyring(store, sodium, ring.vaultId);
  expect(loaded && openFrame(sodium, loaded, frame, c)).toEqual(samplePlain());

  const identity = createDeviceIdentity(sodium);
  await saveDeviceIdentity(store, identity);
  const back = await loadDeviceIdentity(store, identity.deviceId);
  expect(back?.deviceId).toBe(identity.deviceId);
  expect(back?.box.publicKey).toEqual(identity.box.publicKey);
  expect(back?.signPublicKey).toEqual(identity.signPublicKey);
  expect(back?.box.secretKey.expose()).toEqual(identity.box.secretKey.expose());
  expect(back?.signSecretKey.expose()).toEqual(identity.signSecretKey.expose());
  expect(loaded?.recovery).toEqual(ring.recovery);

  await store.delete(keyringName(ring.vaultId));
  expect(await loadKeyring(store, sodium, ring.vaultId)).toBeNull();
  return ring;
}

describe("KeyStore adapters", () => {
  it("in memory", async () => {
    await roundtrip(new InMemoryKeyStore());
  });

  it("Electron safeStorage keeps only safeStorage ciphertext in files", async () => {
    const files = memoryFiles();
    const store = createSafeStorageKeyStore(fakeSafeStorage(), files);
    const ring = newRing();
    await saveKeyring(store, ring);
    const blob = files.blobs.get(keyringName(ring.vaultId));
    expect(blob && new TextDecoder().decode(blob).startsWith("enc:")).toBe(true);
    await roundtrip(store);
  });

  it("safeStorage refuses to store keys without a real OS keyring", async () => {
    for (const ss of [fakeSafeStorage("basic_text"), fakeSafeStorage("keychain", false)]) {
      const store = createSafeStorageKeyStore(ss, memoryFiles());
      await expect(saveKeyring(store, newRing())).rejects.toMatchObject({
        code: "keystore_unavailable",
      });
    }
  });

  it("expo-secure-store holds one key-encryption key, after first unlock, this device only", async () => {
    const ss = fakeSecureStore();
    const files = memoryFiles();
    await roundtrip(createSecureStoreKeyStore(sodium, ss, files));
    expect(new Set(ss.accessible)).toEqual(new Set([7]));
    expect([...ss.items.keys()]).toEqual(["cashu.keystore.kek"]);
    expect(fromBase64(ss.items.get("cashu.keystore.kek") ?? "").length).toBe(32);
  });

  it("expo values live sealed in files, so a ring with many generations fits (no 2048-byte limit)", async () => {
    const ss = fakeSecureStore();
    const files = memoryFiles();
    const store = createSecureStoreKeyStore(sodium, ss, files);
    const ring = newRing();
    for (let i = 0; i < 100; i++) rotateKeyring(sodium, ring);
    await saveKeyring(store, ring);
    const blob = files.blobs.get(keyringName(ring.vaultId));
    expect(blob && blob.length > 2048).toBe(true);
    // Sealed: no key bytes in the file.
    const hex = Buffer.from(blob ?? []).toString("hex");
    for (const e of ring.entries())
      expect(hex).not.toContain(Buffer.from(e.key.expose()).toString("hex"));
    // A fresh store over the same Keychain item and files (app restart) reads it back.
    const again = await loadKeyring(
      createSecureStoreKeyStore(sodium, ss, files),
      sodium,
      ring.vaultId,
    );
    expect(again?.active.kid).toBe(ring.active.kid);
  });

  it("expo blobs are bound to their name and to this device's key-encryption key", async () => {
    const ss = fakeSecureStore();
    const files = memoryFiles();
    const store = createSecureStoreKeyStore(sodium, ss, files);
    await store.set("cashu.a", new Uint8Array([1, 2, 3]));
    await store.set("cashu.b", new Uint8Array([4, 5, 6]));
    const a = files.blobs.get("cashu.a");
    if (!a) throw new Error("missing");
    files.blobs.set("cashu.b", a);
    await expect(store.get("cashu.b")).rejects.toMatchObject({ code: "keystore_corrupt" });
    // Files restored onto a phone without the Keychain item cannot be read.
    const restored = createSecureStoreKeyStore(sodium, fakeSecureStore(), files);
    await expect(restored.get("cashu.a")).rejects.toMatchObject({ code: "keystore_unavailable" });
  });

  it("rejects names expo-secure-store cannot hold", async () => {
    const store = new InMemoryKeyStore();
    for (const bad of ["", "a/b", "a b", "ä", "x".repeat(129)]) {
      await expect(store.set(bad, new Uint8Array(1))).rejects.toBeInstanceOf(CryptoError);
    }
  });

  it("a corrupt or swapped stored device identity is reported, not half-loaded", async () => {
    const store = new InMemoryKeyStore();
    const a = createDeviceIdentity(sodium);
    const b = createDeviceIdentity(sodium);
    await store.set(deviceIdentityName(a.deviceId), new Uint8Array(10));
    await expect(loadDeviceIdentity(store, a.deviceId)).rejects.toMatchObject({
      code: "bad_payload",
    });
    // B's blob under A's name: the device id inside does not match.
    await saveDeviceIdentity(store, b);
    const blob = await store.get(deviceIdentityName(b.deviceId));
    if (!blob) throw new Error("missing blob");
    await store.set(deviceIdentityName(a.deviceId), blob);
    await expect(loadDeviceIdentity(store, a.deviceId)).rejects.toMatchObject({
      code: "bad_payload",
    });
  });

  it("a stored identity keeps no public key: both are recomputed from the secrets", async () => {
    const store = new InMemoryKeyStore();
    const a = createDeviceIdentity(sodium);
    await saveDeviceIdentity(store, a);
    const blob = await store.get(deviceIdentityName(a.deviceId));
    expect(blob?.length).toBe("cashu/device/v2".length + 16 + 64);
    const hex = Buffer.from(blob ?? []).toString("hex");
    expect(hex).not.toContain(Buffer.from(a.box.publicKey).toString("hex"));
    expect(hex).not.toContain(Buffer.from(a.signPublicKey).toString("hex"));
  });

  it("concurrent first writes share one key-encryption key; a fresh store reads both", async () => {
    const ss = fakeSecureStore();
    const files = memoryFiles();
    const store = createSecureStoreKeyStore(sodium, ss, files);
    const identity = createDeviceIdentity(sodium);
    const ring = newRing();
    await Promise.all([saveDeviceIdentity(store, identity), saveKeyring(store, ring)]);
    const restarted = createSecureStoreKeyStore(sodium, ss, files);
    expect((await loadDeviceIdentity(restarted, identity.deviceId))?.signPublicKey).toEqual(
      identity.signPublicKey,
    );
    expect((await loadKeyring(restarted, sodium, ring.vaultId))?.active.kid).toBe(ring.active.kid);
  });

  it("a malformed stored key-encryption key is keystore_corrupt and is not cached", async () => {
    const ss = fakeSecureStore();
    const files = memoryFiles();
    await createSecureStoreKeyStore(sodium, ss, files).set("cashu.a", new Uint8Array([1]));
    const good = ss.items.get("cashu.keystore.kek") ?? "";
    ss.items.set("cashu.keystore.kek", "AAAA");
    const store = createSecureStoreKeyStore(sodium, ss, files);
    await expect(store.get("cashu.a")).rejects.toMatchObject({ code: "keystore_corrupt" });
    ss.items.set("cashu.keystore.kek", good);
    expect(await store.get("cashu.a")).toEqual(new Uint8Array([1]));
  });

  it("the in-memory store is only on the testing subpath, never the main entry", async () => {
    const main = await import("../index.js");
    expect(Object.keys(main.crypto)).not.toContain("InMemoryKeyStore");
    const testing = await import("../testing/index.js");
    expect(testing.InMemoryKeyStore).toBe(InMemoryKeyStore);
  });

  it("base64 helpers roundtrip every byte value", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(all))).toEqual(all);
  });
});
