// Keying a freshly opened SQLCipher connection (pure: the expo database arrives as a port, so the order
// of statements is tested in Node). SQLCipher takes the key as the first statement on the connection;
// plain SQLite ignores an unknown pragma silently, so the cipher's presence is checked, never assumed:
// a binary built without SQLCipher must fail loudly instead of writing plaintext. `cipher_version`
// proves the binary, not the key: one probe read proves the key opens the file. A key that does not
// (a Keychain item that outlived an app delete, files restored from another phone, or a torn first page
// of one file: SQLCipher answers both with "not a database") throws `db_key_mismatch`. The boot decides
// per file (`openWithKeyRecovery`, `deviceStoreMismatch`, `openVaultFiles`): a rebuildable file is
// recreated alone, a paired vault's files are never deleted, and everything is discarded only when the
// key opens no file at all.

/** The part of expo-sqlite's `SQLiteDatabase` the keying uses. */
export interface KeyableDatabase {
  execSync(sql: string): void;
  getFirstSync<T>(sql: string): T | null;
}

/** A raw 256-bit SQLCipher key as 64 lowercase hex characters. */
export const DB_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Apply `keyHex` to `db` before any other statement and return SQLCipher's version. The key is a raw
 * key (`x'..'`: no key derivation on open). PRAGMA takes no bound parameters, so the key is validated
 * before it is interpolated. Throws `sqlcipher_unavailable` when the binary has no SQLCipher.
 */
export function keyDatabase(db: KeyableDatabase, keyHex: string): string {
  if (!DB_KEY_PATTERN.test(keyHex)) throw new Error("db_key_invalid: expected 64 hex characters");
  db.execSync(`PRAGMA key = "x'${keyHex}'"`);
  const row = db.getFirstSync<{ cipher_version: string }>("PRAGMA cipher_version");
  if (row === null || typeof row.cipher_version !== "string")
    throw new Error("sqlcipher_unavailable: rebuild the app with useSQLCipher");
  try {
    db.getFirstSync("SELECT count(*) AS n FROM sqlite_master");
  } catch (error) {
    if (isNotADatabase(error)) throw new Error("db_key_mismatch: the key does not open this file");
    throw error;
  }
  return row.cipher_version;
}

/** SQLite's `SQLITE_NOTADB` (26), as expo-sqlite reports it: the page under this key is not a database. */
function isNotADatabase(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return /not a database|SQLITE_NOTADB|\bcode 26\b/i.test(text);
}

/** The keyed open failed because the key does not open the file (`db_key_mismatch`). */
export function isDbKeyMismatch(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("db_key_mismatch");
}

/**
 * Run `open`; when it fails with `db_key_mismatch`, `discard` (the file `open` opens, or what
 * `deviceStoreMismatch` names) and run `open` once more (on empty files). Any other failure, and a
 * mismatch on the second run, is thrown.
 */
export function openWithKeyRecovery<T>(open: () => T, discard: () => void): T {
  try {
    return open();
  } catch (error) {
    if (!isDbKeyMismatch(error)) throw error;
    discard();
    return open();
  }
}

/** The device store's file; its key mismatch decides between it alone and every file. */
export const DEVICE_DB = "device.db";
/** The device's market price cache file (rebuildable: recreated alone on a key mismatch). */
export const MARKET_DB = "market.db";

/** `vault-<id>.db` or `log-<id>.db`: the vault id, else undefined. */
export function vaultOfFile(file: string): string | undefined {
  return /^(?:vault|log)-([0-9a-f]{32})\.db$/u.exec(file)?.[1];
}

/**
 * Which files to delete when the device store does not open under the key. When the key opens any
 * other file (`opens`: a probe of one file, false when it cannot tell), the device store alone is broken
 * and only it is rebuilt. Otherwise the key opens no file at all and every file goes, except the files
 * of a vault that is not a demo vault (`isDemo`): with the device store unreadable nobody can tell
 * whether that vault is paired, so its files stay for a repair (the new device store does not list it).
 */
export function deviceStoreMismatch(
  files: readonly string[],
  opens: (file: string) => boolean,
  isDemo: (vault: string) => boolean,
): readonly string[] {
  const others = files.filter((file) => file !== DEVICE_DB);
  if (others.some(opens)) return [DEVICE_DB];
  return files.filter((file) => {
    const vault = vaultOfFile(file);
    return vault === undefined || isDemo(vault);
  });
}

/** What `openBaseFiles` opens and deletes (expo-sqlite on the phone, a fake disk in the tests). */
export interface BaseFiles<D extends { close(): void }, P> {
  openDevice(): D;
  openPrices(): P;
  /** Every database file name (`*.db`). */
  files(): readonly string[];
  /** Whether the key opens `file` (a probe; false when it cannot tell). */
  opens(file: string): boolean;
  /** Delete one database file with its sidecars. */
  remove(file: string): void;
  isDemo(vault: string): boolean;
  /** A value-free bench line: why and how many files were deleted. */
  report(reason: string, files: number): void;
}

/**
 * Open the device store and the price cache with the per-file key mismatch rules: the price cache is
 * recreated alone; the device store alone when the key opens another file, else the files
 * `deviceStoreMismatch` names. A device store opened before a failure of the price cache is closed.
 */
export function openBaseFiles<D extends { close(): void }, P>(
  ports: BaseFiles<D, P>,
): { readonly device: D; readonly prices: P } {
  const device = openWithKeyRecovery(ports.openDevice, () => {
    const doomed = deviceStoreMismatch(ports.files(), ports.opens, ports.isDemo);
    for (const file of doomed) ports.remove(file);
    const alone = doomed.length === 1 && doomed[0] === DEVICE_DB;
    ports.report(alone ? "device_key_mismatch" : "key_mismatch", doomed.length);
  });
  try {
    const prices = openWithKeyRecovery(ports.openPrices, () => {
      ports.remove(MARKET_DB);
      ports.report("market_key_mismatch", 1);
    });
    return { device, prices };
  } catch (error) {
    device.close();
    throw error;
  }
}

/** One vault's databases this launch: opened, or left on disk for a repair (`needs_repair`). */
export type VaultFiles<T> =
  | { readonly kind: "opened"; readonly value: T }
  | { readonly kind: "needs_repair" };

/**
 * Open one vault's view and log (`open`). On a key mismatch a demo vault is rebuilt like a half-built
 * one (`recreate` deletes its two files, then one more `open`); a paired vault's files are never
 * deleted: the vault is reported `needs_repair` and its session goes to `failed`. Any other failure is
 * thrown.
 */
export function openVaultFiles<T>(
  kind: "paired" | "demo",
  open: () => T,
  recreate: () => void,
): VaultFiles<T> {
  try {
    return { kind: "opened", value: open() };
  } catch (error) {
    if (!isDbKeyMismatch(error)) throw error;
    if (kind === "paired") return { kind: "needs_repair" };
    recreate();
    return { kind: "opened", value: open() };
  }
}
