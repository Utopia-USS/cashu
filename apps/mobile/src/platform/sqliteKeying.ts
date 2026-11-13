// Keying a freshly opened SQLCipher connection (pure: the expo database arrives as a port, so the order
// of statements is tested in Node). SQLCipher takes the key as the first statement on the connection;
// plain SQLite ignores an unknown pragma silently, so the cipher's presence is checked, never assumed:
// a binary built without SQLCipher must fail loudly instead of writing plaintext. `cipher_version`
// proves the binary, not the key: one probe read proves the key opens the file. A key that does not
// (a Keychain item that outlived an app delete, files restored from another phone) throws
// `db_key_mismatch`, which the boot treats like files without a key: discard and rebuild.

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
 * Run `open`; when it fails with `db_key_mismatch`, `discard` every database file and run `open` once
 * more (on empty files). Any other failure, and a mismatch on the second run, is thrown.
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
