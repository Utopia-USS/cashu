// The phone's database key: one random 256-bit SQLCipher key for every SQLite file on this device (the
// vaults, the device store, the market cache), kept as its own Keychain item so the synchronous boot can
// read it (expo-secure-store's sync API). Same options as the KeyStore's key-encryption key: readable
// after the first unlock, because background work opens the databases while the phone is locked, and
// never biometric-gated for the same reason; never backed up, never moved to another device.
// Pure over the secure store and randomness ports; `phoneDbKey` in sqlite.ts binds them to Expo.
import { crypto } from "@cashu/sync/engine";
import { DB_KEY_PATTERN } from "./sqliteKeying";

/** The Keychain item of the database key (service "cashu"). */
export const DB_KEY_ITEM = "cashu.db.key";

const KEY_BYTES = 32;

/** The part of expo-secure-store the database key uses (its synchronous read and write). */
export interface SyncSecureStore {
  getItem(key: string, options?: crypto.SecureStoreOptions): string | null;
  setItem(key: string, value: string, options?: crypto.SecureStoreOptions): void;
  deleteItemAsync(key: string, options?: crypto.SecureStoreOptions): Promise<void>;
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: number;
}

export interface DbKey {
  /**
   * Whether the key exists. `false` only when the Keychain says the item is not there; a locked
   * Keychain (before the first unlock) throws instead, so a missing answer is never taken for "no key".
   */
  exists(): boolean;
  /** The key as 64 hex characters, created on first use. */
  loadOrCreate(): string;
  /** Delete the key (the phone wipe); missing is not an error. */
  delete(): Promise<void>;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function createDbKey(
  secureStore: SyncSecureStore,
  randomBytes: (count: number) => Uint8Array,
): DbKey {
  const options = crypto.secureStoreOptions(secureStore);
  const read = (): string | null => {
    const value = secureStore.getItem(DB_KEY_ITEM, options);
    if (value !== null && !DB_KEY_PATTERN.test(value)) throw new Error("db_key_corrupt");
    return value;
  };
  return {
    exists: () => read() !== null,
    loadOrCreate() {
      const existing = read();
      if (existing !== null) return existing;
      const bytes = randomBytes(KEY_BYTES);
      if (bytes.length !== KEY_BYTES) throw new Error("db_key_random_failed");
      const fresh = hex(bytes);
      bytes.fill(0);
      secureStore.setItem(DB_KEY_ITEM, fresh, options);
      // Adopt what the Keychain actually holds, not what we meant to write.
      const stored = read();
      if (stored === null) throw new Error("db_key_unavailable");
      return stored;
    },
    delete: () => secureStore.deleteItemAsync(DB_KEY_ITEM, options),
  };
}
