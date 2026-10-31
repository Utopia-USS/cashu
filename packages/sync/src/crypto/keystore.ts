// Where a device keeps its secrets (data keyrings, its own X25519 secret key). The platform module
// is injected, so this package imports neither Electron nor Expo:
//   desktop: Electron `safeStorage` (macOS Keychain / Windows DPAPI / libsecret) + files for the blobs
//   iOS:     `expo-secure-store` (Keychain, this device only, no iCloud Keychain backup)
//   tests:   in memory

import { fromBase64, toBase64 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { decodeKeyPayload, encodeKeyPayload, type Keyring } from "./keys.js";
import { Secret } from "./secret.js";
import type { Sodium } from "./sodium.js";
import { BoxKeyPair } from "./wrap.js";

export interface KeyStore {
  get(name: string): Promise<Uint8Array | null>;
  set(name: string, value: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

// expo-secure-store accepts only these characters in a key; the same rule everywhere keeps names portable.
const NAME = /^[A-Za-z0-9._-]{1,128}$/;

function checkName(name: string): void {
  if (!NAME.test(name)) throw new CryptoError("bad_key_name");
}

export class InMemoryKeyStore implements KeyStore {
  #items = new Map<string, Uint8Array>();

  async get(name: string): Promise<Uint8Array | null> {
    checkName(name);
    const v = this.#items.get(name);
    return v ? v.slice() : null;
  }

  async set(name: string, value: Uint8Array): Promise<void> {
    checkName(name);
    this.#items.get(name)?.fill(0);
    this.#items.set(name, value.slice());
  }

  async delete(name: string): Promise<void> {
    checkName(name);
    this.#items.get(name)?.fill(0);
    this.#items.delete(name);
  }
}

/** The subset of Electron's `safeStorage` used here. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  /** Linux only; "basic_text" means no OS keyring, i.e. a hard-coded password. */
  getSelectedStorageBackend?(): string;
  encryptString(plain: string): Uint8Array;
  decryptString(encrypted: Uint8Array): string;
}

/** Blob storage for the safeStorage ciphertexts (e.g. one file per name in the app's data dir). */
export interface BlobFiles {
  read(name: string): Promise<Uint8Array | null>;
  write(name: string, value: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

/**
 * Desktop store: values encrypted with the OS keychain-backed safeStorage key, ciphertext in files.
 * Refuses to work when safeStorage would fall back to a plaintext-equivalent backend.
 */
export function createSafeStorageKeyStore(
  safeStorage: SafeStorageLike,
  files: BlobFiles,
): KeyStore {
  const ensure = () => {
    if (
      !safeStorage.isEncryptionAvailable() ||
      safeStorage.getSelectedStorageBackend?.() === "basic_text"
    ) {
      throw new CryptoError("keystore_unavailable");
    }
  };
  return {
    async get(name) {
      checkName(name);
      ensure();
      const blob = await files.read(name);
      return blob ? fromBase64(safeStorage.decryptString(blob)) : null;
    },
    async set(name, value) {
      checkName(name);
      ensure();
      await files.write(name, safeStorage.encryptString(toBase64(value)));
    },
    async delete(name) {
      checkName(name);
      await files.remove(name);
    },
  };
}

/** The subset of `expo-secure-store` used here. */
export interface SecureStoreLike {
  getItemAsync(key: string, options?: SecureStoreOptions): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: SecureStoreOptions): Promise<void>;
  deleteItemAsync(key: string, options?: SecureStoreOptions): Promise<void>;
  /** `SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY`: readable after first unlock, never migrated to another device. */
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: number;
}

export interface SecureStoreOptions {
  keychainService?: string;
  keychainAccessible?: number;
}

export function createSecureStoreKeyStore(
  secureStore: SecureStoreLike,
  keychainService = "cashu",
): KeyStore {
  const options: SecureStoreOptions = {
    keychainService,
    keychainAccessible: secureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  };
  return {
    async get(name) {
      checkName(name);
      const v = await secureStore.getItemAsync(name, options);
      return v === null ? null : fromBase64(v);
    },
    async set(name, value) {
      checkName(name);
      await secureStore.setItemAsync(name, toBase64(value), options);
    },
    async delete(name) {
      checkName(name);
      await secureStore.deleteItemAsync(name, options);
    },
  };
}

export const keyringName = (vaultId: string) => `cashu.vault.${vaultId}.keys`;
export const deviceKeyName = (deviceId: string) => `cashu.device.${deviceId}.box`;

export async function saveKeyring(store: KeyStore, ring: Keyring): Promise<void> {
  const payload = encodeKeyPayload(ring);
  try {
    await store.set(keyringName(ring.vaultId), payload);
  } finally {
    payload.fill(0);
  }
}

export async function loadKeyring(
  store: KeyStore,
  sodium: Sodium,
  vaultId: string,
): Promise<Keyring | null> {
  const payload = await store.get(keyringName(vaultId));
  if (!payload) return null;
  try {
    return decodeKeyPayload(sodium, payload, vaultId);
  } finally {
    payload.fill(0);
  }
}

/** Stored as secret key (32) | public key (32). */
export async function saveDeviceKeyPair(
  store: KeyStore,
  deviceId: string,
  pair: BoxKeyPair,
): Promise<void> {
  const blob = new Uint8Array(64);
  blob.set(pair.secretKey.expose(), 0);
  blob.set(pair.publicKey, 32);
  try {
    await store.set(deviceKeyName(deviceId), blob);
  } finally {
    blob.fill(0);
  }
}

export async function loadDeviceKeyPair(
  store: KeyStore,
  deviceId: string,
): Promise<BoxKeyPair | null> {
  const blob = await store.get(deviceKeyName(deviceId));
  if (!blob) return null;
  if (blob.length !== 64) {
    blob.fill(0);
    throw new CryptoError("bad_payload");
  }
  const pair = new BoxKeyPair(blob.slice(32), new Secret(blob.slice(0, 32)));
  blob.fill(0);
  return pair;
}
