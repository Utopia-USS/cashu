import { describe, expect, it } from "vitest";
import { fromBase64, toBase64, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { openFrame, sealFrame } from "./frame.js";
import { createDeviceIdentity } from "./identity.js";
import {
  type BlobFiles,
  createSafeStorageKeyStore,
  createSecureStoreKeyStore,
  deviceIdentityName,
  InMemoryKeyStore,
  type KeyStore,
  keyringName,
  loadDeviceIdentity,
  loadKeyring,
  type SafeStorageLike,
  type SecureStoreLike,
  saveDeviceIdentity,
  saveKeyring,
} from "./keystore.js";
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
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 7,
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

  it("expo-secure-store, this device only", async () => {
    const ss = fakeSecureStore();
    await roundtrip(createSecureStoreKeyStore(ss));
    expect(new Set(ss.accessible)).toEqual(new Set([7]));
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

  it("base64 helpers roundtrip every byte value", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(fromBase64(toBase64(all))).toEqual(all);
  });
});
