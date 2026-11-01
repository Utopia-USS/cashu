// Native failures are the only platform stand-in. The crypto implementation, known answers and
// secure-store adapter are real; all keys and payloads are generated synthetic test data.
import { crypto } from "@cashu/sync";
import sodiumWrappers from "libsodium-wrappers";

export function memoryKeyStore(sodium: crypto.Sodium): crypto.KeyStore {
  const items = new Map<string, string>();
  const blobs = new Map<string, Uint8Array>();
  return crypto.createSecureStoreKeyStore(
    sodium,
    {
      getItemAsync: async (key) => items.get(key) ?? null,
      setItemAsync: async (key, value) => void items.set(key, value),
      deleteItemAsync: async (key) => void items.delete(key),
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 7,
    },
    {
      read: async (name) => blobs.get(name) ?? null,
      write: async (name, value) => void blobs.set(name, value),
      remove: async (name) => void blobs.delete(name),
    },
  );
}

export async function runtime(): Promise<crypto.LibsodiumLike> {
  await sodiumWrappers.ready;
  return sodiumWrappers as unknown as crypto.LibsodiumLike;
}

export function withOpenFailure(
  real: crypto.LibsodiumLike,
  failure: () => unknown,
): crypto.LibsodiumLike {
  return {
    ...real,
    crypto_box_seal_open: (cipher, publicKey, privateKey) => {
      try {
        return real.crypto_box_seal_open(cipher, publicKey, privateKey);
      } catch {
        throw failure();
      }
    },
  };
}
