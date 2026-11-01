// The self-test on Node with libsodium-wrappers and an in-memory secure store and files: every check
// passes, a broken library fails the known-answer test, and a KeyStore that loses values is caught.
// The device run (debug screen) uses react-native-libsodium, expo-secure-store and real files.
import { crypto } from "@cashu/sync";
import sodiumWrappers from "libsodium-wrappers";
import { runCryptoSelfTest } from "./cryptoSelfTest";

function memoryKeyStore(sodium: crypto.Sodium): crypto.KeyStore {
  const items = new Map<string, string>();
  const blobs = new Map<string, Uint8Array>();
  return crypto.createSecureStoreKeyStore(
    sodium,
    {
      getItemAsync: async (k) => items.get(k) ?? null,
      setItemAsync: async (k, v) => void items.set(k, v),
      deleteItemAsync: async (k) => void items.delete(k),
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 7,
    },
    {
      read: async (n) => blobs.get(n) ?? null,
      write: async (n, v) => void blobs.set(n, v),
      remove: async (n) => void blobs.delete(n),
    },
  );
}

async function lib(): Promise<crypto.LibsodiumLike> {
  await sodiumWrappers.ready;
  return sodiumWrappers as unknown as crypto.LibsodiumLike;
}

describe("crypto self-test", () => {
  it("passes every check on a working runtime", async () => {
    const r = await runCryptoSelfTest({ lib: await lib(), keyStore: memoryKeyStore });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.checks.map((c) => c.name)).toEqual([
      "knownAnswer",
      "vault",
      "frame",
      "frameTamper",
      "sealedBox",
      "sealedBoxWrongKey",
      "keyStore",
    ]);
    expect(r.ok).toBe(true);
    expect(r.nativeAead).toBe("supported");
  });

  it("fails closed when a primitive is broken", async () => {
    const real = await lib();
    const broken = { ...real, crypto_generichash: () => new Uint8Array(32) };
    const r = await runCryptoSelfTest({ lib: broken, keyStore: memoryKeyStore });
    expect(r.ok).toBe(false);
    expect(r.checks).toEqual([
      {
        name: "knownAnswer",
        ok: false,
        code: "unsupported_runtime: crypto_generichash (known answer) (wrong value)",
      },
    ]);
  });

  it("names the failure message a library uses that the mapping does not know", async () => {
    const real = await lib();
    // Android's JSI wraps a host function's error: "Exception in HostFunction: <message>" + stack.
    const wrapped = {
      ...real,
      crypto_box_seal_open: (c: Uint8Array, pk: Uint8Array, sk: Uint8Array) => {
        try {
          return real.crypto_box_seal_open(c, pk, sk);
        } catch {
          throw new Error("Exception in HostFunction: seal failed\n\nError: seal failed\n    at x");
        }
      },
    };
    const r = await runCryptoSelfTest({ lib: wrapped, keyStore: memoryKeyStore });
    expect(r.checks[0]?.code).toBe(
      'unsupported_runtime: tampered seal_open failure "Exception in HostFunction: seal failed", crypto_box_seal_open failure "Exception in HostFunction: seal failed"',
    );
  });

  it("catches a KeyStore that does not keep values", async () => {
    const forgetful = (): crypto.KeyStore => ({
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
    });
    const r = await runCryptoSelfTest({ lib: await lib(), keyStore: forgetful });
    expect(r.checks.find((c) => c.name === "keyStore")).toEqual({
      name: "keyStore",
      ok: false,
      code: "mismatch",
    });
  });
});
