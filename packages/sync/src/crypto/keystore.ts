// Where a device keeps its secrets (data keyrings, its own device identity). The platform module
// is injected, so this package imports neither Electron nor Expo:
//   desktop: Electron `safeStorage` (macOS Keychain / Windows DPAPI / libsecret) + files for the blobs
//   iOS:     `expo-secure-store` holds one key-encryption key; values are sealed under it in files
//   tests:   in memory (`@cashu/sync/testing`, never the main entry)
//
// Best effort, as everywhere in JS: values pass through immutable strings (base64 for safeStorage)
// and GC copies that cannot be wiped. Any code running as the user (or inside the app) can ask
// safeStorage / DPAPI / the Keychain to decrypt; that is within this threat model.

import { concat, fromBase64, fromHex, Reader, toBase64, toHex, utf8 } from "./encoding.js";
import { CryptoError } from "./errors.js";
import { assertDeviceId, DEVICE_ID_BYTES, DeviceIdentity } from "./identity.js";
import {
  assertVaultId,
  decodeKeyPayload,
  emptyLike,
  encodeKeyPayload,
  type Keyring,
} from "./keys.js";
import { Secret } from "./secret.js";
import { KEY_BYTES, NONCE_BYTES, type Sodium, TAG_BYTES } from "./sodium.js";

export interface KeyStore {
  get(name: string): Promise<Uint8Array | null>;
  set(name: string, value: Uint8Array): Promise<void>;
  delete(name: string): Promise<void>;
}

// expo-secure-store accepts only these characters in a key; the same rule everywhere keeps names portable.
const NAME = /^[A-Za-z0-9._-]{1,128}$/;

/** Not public API: shared name rule for every store (also used by `testing.ts`). */
export function checkName(name: string): void {
  if (!NAME.test(name)) throw new CryptoError("bad_key_name");
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
      if (!blob) return null;
      // Electron's decryptString and atob throw plain errors on a damaged blob: report them as
      // keystore_corrupt, like the mobile store, never as an unclassified exception.
      try {
        return fromBase64(safeStorage.decryptString(blob));
      } catch {
        throw new CryptoError("keystore_corrupt");
      }
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
  /** `SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. */
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: number;
}

export interface SecureStoreOptions {
  keychainService?: string;
  keychainAccessible?: number;
}

const KEK_ITEM = "cashu.keystore.kek";
const SEALED_VERSION = 1;

/**
 * Mobile store: the Keychain (expo-secure-store) holds ONE random 32-byte key-encryption key; each
 * value is sealed with XChaCha20-Poly1305 under it (AAD = 0x01 | the name, so blobs cannot be
 * swapped between names or versions) and kept through `files`, so SecureStore's ~2048-byte value
 * limit never applies however many key generations a ring collects.
 * Blob: 0x01 | nonce (24) | ciphertext + tag. A blob that does not open is `keystore_corrupt`.
 * Rolling a blob back to an older one of the same name is not detected (local attacker only).
 *
 * Accessibility is AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY because background sync must read keys while
 * the phone is locked (WHEN_UNLOCKED would refuse then); THIS_DEVICE_ONLY keeps the key out of
 * backups and off other devices.
 */
export function createSecureStoreKeyStore(
  sodium: Sodium,
  secureStore: SecureStoreLike,
  files: BlobFiles,
): KeyStore {
  const options: SecureStoreOptions = {
    keychainService: "cashu",
    keychainAccessible: secureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  };
  // Single flight: one get-or-create at a time, so concurrent first writes cannot create two KEKs.
  // Only a successful result is cached; a failure is retried on the next call.
  let cached: Secret | undefined;
  let inFlight: Promise<Secret | null> | undefined;
  const readKek = async (): Promise<Secret | null> => {
    const v = await secureStore.getItemAsync(KEK_ITEM, options);
    if (v === null) return null;
    const bytes = fromBase64(v);
    if (bytes.length !== KEY_BYTES) throw new CryptoError("keystore_corrupt");
    return new Secret(bytes);
  };
  const loadKek = (create: boolean): Promise<Secret | null> => {
    if (cached) return Promise.resolve(cached);
    const previous = inFlight ?? Promise.resolve(null);
    const run = previous
      .catch(() => null)
      .then(async () => {
        if (cached) return cached;
        let kek = await readKek();
        if (!kek && create) {
          const fresh = sodium.randomBytes(KEY_BYTES);
          await secureStore.setItemAsync(KEK_ITEM, toBase64(fresh), options);
          fresh.fill(0);
          // Adopt what the Keychain actually holds, not what we meant to write.
          kek = await readKek();
          if (!kek) throw new CryptoError("keystore_unavailable");
        }
        if (kek) cached = kek;
        return kek;
      });
    inFlight = run;
    return run;
  };
  const aad = (name: string) => concat(Uint8Array.of(SEALED_VERSION), utf8(name));
  return {
    async get(name) {
      checkName(name);
      const blob = await files.read(name);
      if (!blob) return null;
      // A blob without its key (e.g. a restored backup on a new phone) cannot be read.
      const key = await loadKek(false);
      if (!key) throw new CryptoError("keystore_unavailable");
      if (blob.length < 1 + NONCE_BYTES + TAG_BYTES || blob[0] !== SEALED_VERSION) {
        throw new CryptoError("keystore_corrupt");
      }
      const nonce = blob.subarray(1, 1 + NONCE_BYTES);
      try {
        return sodium.aeadDecrypt(blob.subarray(1 + NONCE_BYTES), aad(name), nonce, key.expose());
      } catch (e) {
        if (e instanceof CryptoError && e.code === "auth_failed") {
          throw new CryptoError("keystore_corrupt");
        }
        throw e;
      }
    },
    async set(name, value) {
      checkName(name);
      const key = await loadKek(true);
      if (!key) throw new CryptoError("keystore_unavailable");
      const nonce = sodium.randomBytes(NONCE_BYTES);
      const cipher = sodium.aeadEncrypt(value, aad(name), nonce, key.expose());
      await files.write(name, concat(Uint8Array.of(SEALED_VERSION), nonce, cipher));
    },
    async delete(name) {
      checkName(name);
      await files.remove(name);
    },
  };
}

export const keyringName = (vaultId: string) => `cashu.vault.${vaultId}.keys`;
export const deviceIdentityName = (deviceId: string) => `cashu.device.${deviceId}.identity`;

/** Saves the payload v3 of the whole ring (keys and pinned recovery public keys). */
export async function saveKeyring(store: KeyStore, ring: Keyring): Promise<void> {
  const payload = encodeKeyPayload(ring);
  try {
    await store.set(keyringName(ring.vaultId), payload);
  } finally {
    payload.fill(0);
  }
}

/**
 * Loads a stored ring. The store is local and trusted, but the loaded ring must still satisfy the
 * keyring invariants (bounds, generations from 1 without a gap, the right vault).
 */
export async function loadKeyring(
  store: KeyStore,
  sodium: Sodium,
  vaultId: string,
): Promise<Keyring | null> {
  assertVaultId(vaultId);
  const payload = await store.get(keyringName(vaultId));
  if (!payload) return null;
  let incoming: Keyring;
  try {
    incoming = decodeKeyPayload(sodium, payload);
  } finally {
    payload.fill(0);
  }
  try {
    if (incoming.vaultId !== vaultId) throw new CryptoError("vault_mismatch");
    const ring = emptyLike(incoming);
    ring.merge(incoming);
    return ring;
  } finally {
    incoming.wipe();
  }
}

const IDENTITY_MAGIC = utf8("cashu/device/v2");
const IDENTITY_BLOB_BYTES = IDENTITY_MAGIC.length + DEVICE_ID_BYTES + 2 * KEY_BYTES;

/**
 * Stored as "cashu/device/v2" | device id (16 raw bytes) | box secret key (32) | Ed25519 seed (32).
 * Nothing public is stored: loading recomputes both public keys, so a blob cannot mismatch.
 */
export async function saveDeviceIdentity(store: KeyStore, identity: DeviceIdentity): Promise<void> {
  const blob = concat(
    IDENTITY_MAGIC,
    fromHex(identity.deviceId),
    identity.box.secretKey.expose(),
    identity.signSecretKey.expose(),
  );
  try {
    await store.set(deviceIdentityName(identity.deviceId), blob);
  } finally {
    blob.fill(0);
  }
}

export async function loadDeviceIdentity(
  store: KeyStore,
  deviceId: string,
): Promise<DeviceIdentity | null> {
  assertDeviceId(deviceId);
  const blob = await store.get(deviceIdentityName(deviceId));
  if (!blob) return null;
  try {
    if (blob.length !== IDENTITY_BLOB_BYTES) throw new CryptoError("bad_payload");
    const r = new Reader(blob);
    const magic = r.take(IDENTITY_MAGIC.length);
    if (!magic.every((b, i) => b === IDENTITY_MAGIC[i])) throw new CryptoError("bad_payload");
    if (toHex(r.take(DEVICE_ID_BYTES)) !== deviceId) throw new CryptoError("bad_payload");
    const boxSecret = new Secret(r.take(KEY_BYTES).slice());
    const signSeed = new Secret(r.take(KEY_BYTES).slice());
    r.end();
    return new DeviceIdentity(deviceId, boxSecret, signSeed);
  } finally {
    blob.fill(0);
  }
}
