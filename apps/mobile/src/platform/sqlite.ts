// The stores' SQLite on the phone: expo-sqlite's synchronous API behind the store's expo adapter, so
// the store engine runs in-process on the JS thread (cashu-ts-architecture layers.md, "Which process
// runs what"). One view database and one private log database per vault, the device store and the
// market price cache, in expo-sqlite's directory under the app's private documents
// (`<Documents>/SQLite/`). Every file is encrypted at rest with SQLCipher under the one device key
// (`dbKey.ts`), which is readable after the first unlock like the KeyStore's Keychain item, so
// background work can open the files while the phone is locked; iOS data protection (complete until
// first user authentication) sits under that.

import { DeviceStore } from "@cashu/store/device";
import type { VaultSalt } from "@cashu/store/gid";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { builtinModules, expoSqliteDriver, Store } from "@cashu/store/runtime";
import type { SqlDriver } from "@cashu/store/sync";
import { getRandomBytes } from "expo-crypto";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";
import { deleteDatabaseSync, openDatabaseSync, type SQLiteDatabase } from "expo-sqlite";
import { createDbKey } from "./dbKey";
import { keyDatabase } from "./sqliteKeying";

/** This phone's database key in the Keychain. */
export const phoneDbKey = createDbKey(SecureStore, getRandomBytes);

const vaultFile = (vault: string) => `vault-${vault}.db`;

/** SQLCipher's version, recorded by the first keyed open of this launch. */
let cipherVersion: string | null = null;

/**
 * Open `file` keyed with `keyHex` (64 hex characters): the key is the connection's first statement, a
 * binary without SQLCipher throws `sqlcipher_unavailable` instead of running on plaintext, and a key that
 * does not open the file throws `db_key_mismatch`.
 */
function openEncrypted(file: string, keyHex: string): SQLiteDatabase {
  // The only `openDatabaseSync` of the app: every database is opened here, keyed (sqliteOpen.test.ts
  // fails on a second call site, which would store plaintext).
  const db = openDatabaseSync(file);
  try {
    cipherVersion = keyDatabase(db, keyHex);
  } catch (error) {
    db.closeSync();
    throw error;
  }
  return db;
}

/** SQLCipher's version for the debug screen (null: no database was opened encrypted this launch). */
export function storageInfo(): { cipherVersion: string | null } {
  return { cipherVersion };
}

/** Open (or create) the store of `vault`. The store sets WAL + synchronous NORMAL itself. */
export function openVaultStore(vault: string, salt: VaultSalt, keyHex: string): Store {
  return Store.open({
    driver: expoSqliteDriver(openEncrypted(vaultFile(vault), keyHex)),
    vault,
    salt,
    modules: builtinModules(),
    // the phone reads the companion tables (month aggregates, recurring payments, search)
    companionReads: true,
  });
}

/**
 * Close `store` (the store of `vault`), delete its database file with the WAL and SHM sidecars, and
 * open a fresh empty one. TRANSITIONAL(S44): only for a half-built companion demo vault.
 */
export function recreateVaultStore(
  store: Store,
  vault: string,
  salt: VaultSalt,
  keyHex: string,
): Store {
  store.close();
  deleteDatabaseSync(vaultFile(vault));
  return openVaultStore(vault, salt, keyHex);
}

const logFile = (vault: string) => `log-${vault}.db`;

/**
 * Open (or create) the private log database of `vault` (`log-<vault>.db`): the sync engine's own log,
 * the command journal, key provenance and the pairing bootstrap. WAL with synchronous FULL: unlike the
 * view, a commit here must survive a power loss (the view can be rebuilt from it, not the reverse).
 */
export function openVaultLog(vault: string, keyHex: string): SqlDriver {
  const driver = expoSqliteDriver(openEncrypted(logFile(vault), keyHex));
  try {
    driver.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL");
  } catch (error) {
    driver.close();
    throw error;
  }
  return driver;
}

/**
 * Close `driver` (the log of `vault`), delete its file with the sidecars and open a fresh empty one.
 * TRANSITIONAL(S44): only for a half-built companion demo vault.
 */
export function recreateVaultLog(driver: SqlDriver, vault: string, keyHex: string): SqlDriver {
  driver.close();
  deleteDatabaseSync(logFile(vault));
  return openVaultLog(vault, keyHex);
}

/** Open (or create) the device-local store (current profile, device settings; never synced). */
export function openDeviceStore(keyHex: string): DeviceStore {
  return DeviceStore.open(expoSqliteDriver(openEncrypted("device.db", keyHex)));
}

/** Open (or create) this device's market price cache (prices are device-local, never synced). */
export function openPriceCache(keyHex: string): SqlPriceCache {
  return new SqlPriceCache(expoSqliteDriver(openEncrypted("market.db", keyHex)));
}

/** The database files (`*.db`) in expo-sqlite's directory: every vault, the device store, the market cache. */
export function databaseFiles(): string[] {
  const dir = new Directory(Paths.document, "SQLite");
  if (!dir.exists) return [];
  return dir
    .list()
    .flatMap((entry) => (entry instanceof File && entry.name.endsWith(".db") ? [entry.name] : []));
}

/**
 * Delete every database file with its `-wal`, `-shm` and `-journal` sidecars; returns the names deleted.
 * expo-sqlite refuses to delete a file it still has open, so every store must be closed first.
 */
export function deleteDatabaseFiles(): string[] {
  const names = databaseFiles();
  for (const name of names) deleteDatabaseSync(name);
  return names;
}

/**
 * Delete one database file (`vault-<id>.db`, `log-<id>.db`, `device.db`, `market.db`) with its sidecars:
 * a per-file key mismatch, a half-built demo vault. The file must be closed first.
 */
export function deleteDatabaseFile(name: string): void {
  deleteDatabaseSync(name);
}
