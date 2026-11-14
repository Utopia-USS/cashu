// The relay config is decoded or absent (never half-set), and the relay identity round-trips through
// the KeyStore and reads as absent when its value does not decode. Synthetic values only.
import { crypto } from "@cashu/sync/engine";
import { memoryKeyStore, memorySecureStore, runtime } from "../selftest/testing/runtime";
import { keyStoreAuthStore, RELAY_AUTH_ITEM } from "./relayAuthStore";
import { parseRelayConfig } from "./relayConfig";

const CONFIG = {
  projectId: "demo-cashu",
  apiKey: "synthetic-api-key",
  appId: "1:000000000000:ios:0000000000000000",
  authDomain: "demo-cashu.example.test",
};

describe("parseRelayConfig", () => {
  it("decodes a complete config", () => {
    expect(parseRelayConfig(JSON.stringify(CONFIG))).toEqual(CONFIG);
  });

  it.each([
    ["missing", undefined],
    ["empty", " "],
    ["not JSON", "{projectId"],
    ["a missing field", JSON.stringify({ ...CONFIG, apiKey: undefined })],
    ["a bad project id", JSON.stringify({ ...CONFIG, projectId: "Bad Project" })],
  ])("reads %s as no relay", (_case, raw) => {
    expect(parseRelayConfig(raw)).toBeUndefined();
  });
});

describe("keyStoreAuthStore", () => {
  it("saves, loads and clears the identity; an undecodable value is absent", async () => {
    const keyStore = memoryKeyStore(crypto.fromLibsodium(await runtime(), { aead: "noble" }));
    const store = keyStoreAuthStore(keyStore);
    expect(await store.load()).toBeUndefined();
    await store.save({ uid: "synthetic-uid", refreshToken: "synthetic-refresh" });
    expect(await store.load()).toEqual({ uid: "synthetic-uid", refreshToken: "synthetic-refresh" });
    await keyStore.set(RELAY_AUTH_ITEM, new TextEncoder().encode("{not json"));
    expect(await store.load()).toBeUndefined();
    await store.clear();
    expect(await keyStore.get(RELAY_AUTH_ITEM)).toBeNull();
  });

  it("reads a value it can no longer open as absent, overwrites it, and throws other failures", async () => {
    const sodium = crypto.fromLibsodium(await runtime(), { aead: "noble" });
    const secure = memorySecureStore();
    const blobs = new Map<string, Uint8Array>();
    let keychainDown = false;
    const keychain = {
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: secure.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      getItemAsync: async (key: string, options?: crypto.SecureStoreOptions) => {
        if (keychainDown) throw new Error("keychain_busy");
        return secure.getItem(key, options);
      },
      setItemAsync: async (key: string, value: string, options?: crypto.SecureStoreOptions) =>
        secure.setItem(key, value, options),
      deleteItemAsync: secure.deleteItemAsync,
    };
    const files: crypto.BlobFiles = {
      read: async (name) => blobs.get(name) ?? null,
      write: async (name, value) => void blobs.set(name, value),
      remove: async (name) => void blobs.delete(name),
    };
    const before = keyStoreAuthStore(crypto.createSecureStoreKeyStore(sodium, keychain, files));
    await before.save({ uid: "synthetic-uid", refreshToken: "synthetic-refresh" });

    // A transient Keychain failure is not "absent".
    keychainDown = true;
    const busy = keyStoreAuthStore(crypto.createSecureStoreKeyStore(sodium, keychain, files));
    await expect(busy.load()).rejects.toThrow("keychain_busy");
    expect(blobs.has(RELAY_AUTH_ITEM)).toBe(true);
    keychainDown = false;

    // Restored onto another phone: the files came back, the Keychain item did not.
    secure.items.clear();
    const after = keyStoreAuthStore(crypto.createSecureStoreKeyStore(sodium, keychain, files));
    expect(await after.load()).toBeUndefined();
    expect(blobs.has(RELAY_AUTH_ITEM)).toBe(false);
    await after.save({ uid: "new-uid", refreshToken: "new-refresh" });
    expect(await after.load()).toEqual({ uid: "new-uid", refreshToken: "new-refresh" });
  });
});
