// The phone's KeyStore (S27): expo-secure-store holds one key-encryption key in the Keychain, values
// are sealed under it and kept as files in the app's private documents directory (`keys/`).
//
// A blob is replaced atomically: iOS may suspend or kill the app at any point (a background task's
// expiry, jetsam, a crash), and expo-file-system writes in place (no `.atomic` option) and moves over an
// existing file by deleting it first. So a write goes to `<name>.bin.tmp`, the current value is renamed
// to `<name>.bin.old`, the new one renamed into `<name>.bin`, and the old one deleted: every step is a
// rename onto a free name (atomic on APFS) or a delete, and a read finds `<name>.bin` or, after a write
// that stopped between the two renames, `<name>.bin.old` (the value before it). A lone `.tmp` is a write
// that never landed and is never read. Process death is covered; a power loss right after a write is
// not (the files are not fsynced: expo-file-system has no call for it).
import { crypto } from "@cashu/sync/engine";
import { Directory, File, Paths } from "expo-file-system";
import * as SecureStore from "expo-secure-store";

const BLOB_FOLDER = "keys";

/** The file operations the atomic replace needs (expo-file-system on the phone, a fake disk in tests). */
export interface BlobDisk {
  exists(file: string): boolean;
  read(file: string): Promise<Uint8Array>;
  /** Create or truncate `file` and write `value` (in place: may be torn by a kill). */
  write(file: string, value: Uint8Array): Promise<void>;
  /** Rename `from` to `to`; `to` does not exist. */
  rename(from: string, to: string): void;
  remove(file: string): void;
}

const current = (name: string) => `${name}.bin`;
const previous = (name: string) => `${name}.bin.old`;
const pending = (name: string) => `${name}.bin.tmp`;

/** `BlobFiles` over `disk` with the atomic replace above (exported for the tests). */
export function atomicBlobFiles(disk: BlobDisk): crypto.BlobFiles {
  return {
    async read(name) {
      if (disk.exists(current(name))) return disk.read(current(name));
      if (disk.exists(previous(name))) return disk.read(previous(name));
      return null;
    },
    async write(name, value) {
      // What an interrupted write left: a torn tmp is dropped, a value parked as old goes back first.
      if (disk.exists(pending(name))) disk.remove(pending(name));
      if (!disk.exists(current(name)) && disk.exists(previous(name)))
        disk.rename(previous(name), current(name));
      if (disk.exists(previous(name))) disk.remove(previous(name));
      await disk.write(pending(name), value);
      const replacing = disk.exists(current(name));
      if (replacing) disk.rename(current(name), previous(name));
      disk.rename(pending(name), current(name));
      if (replacing) disk.remove(previous(name));
    },
    async remove(name) {
      for (const file of [current(name), previous(name), pending(name)])
        if (disk.exists(file)) disk.remove(file);
    },
  };
}

/** The KeyStore's folder under documents (names are `[A-Za-z0-9._-]`, checked by the KeyStore). */
function documentBlobDisk(folder = BLOB_FOLDER): BlobDisk {
  const dir = new Directory(Paths.document, folder);
  const file = (name: string) => new File(dir, name);
  return {
    exists: (name) => file(name).exists,
    read: (name) => file(name).bytes(),
    async write(name, value) {
      if (!dir.exists) dir.create({ intermediates: true });
      const f = file(name);
      if (!f.exists) f.create();
      await f.write(value);
    },
    rename: (from, to) => file(from).rename(to),
    remove: (name) => file(name).delete(),
  };
}

export function createMobileKeyStore(sodium: crypto.Sodium): crypto.KeyStore {
  return crypto.createSecureStoreKeyStore(sodium, SecureStore, atomicBlobFiles(documentBlobDisk()));
}

/** Delete the KeyStore's key-encryption key from the Keychain (the phone wipe); missing is not an error. */
export function deleteKeyStoreKek(): Promise<void> {
  return SecureStore.deleteItemAsync(
    crypto.SECURE_STORE_KEK_ITEM,
    crypto.secureStoreOptions(SecureStore),
  );
}

/** Delete every sealed value under documents/keys (the phone wipe); missing is not an error. */
export function deleteKeyStoreFiles(): void {
  const dir = new Directory(Paths.document, BLOB_FOLDER);
  if (dir.exists) dir.delete();
}

/** Whether documents/keys exists (sealed values, or what an interrupted wipe left of them). */
export function keyStoreFilesExist(): boolean {
  return new Directory(Paths.document, BLOB_FOLDER).exists;
}

// The phone wipe's secrets, ordered so a kill at any point leaves nothing readable after the next
// launch. The database key goes first: from that moment the next launch finds "no database key" and
// finishes the wipe (`discardWithoutDbKey`: databases, `keys/` and the key-encryption key) whatever
// step the kill stopped at. Deleting the key-encryption key first would not be safe: a kill right after
// it leaves the database key, so the next launch opens every database again (the profile's data stays
// on the phone) over keyrings it can no longer read.

/** The wipe's two Keychain items (expo-secure-store on the phone, fakes in tests). */
export interface PhoneSecretItems {
  /** The database key (`cashu.db.key`). */
  deleteDbKey(): Promise<void>;
  /** The KeyStore's key-encryption key (`cashu.keystore.kek`). */
  deleteKek(): Promise<void>;
}

/**
 * Delete the database key, then the key-encryption key. A database key that could not be deleted
 * keeps the key-encryption key too (the rejection is the wipe's failure): only both or the database
 * key alone may be gone, never the key-encryption key alone.
 */
export async function deletePhoneSecrets(items: PhoneSecretItems): Promise<void> {
  await items.deleteDbKey();
  await items.deleteKek();
}

/** What the boot looks at and deletes when the database key is missing. */
export interface WipeLeftovers {
  dbKeyExists(): boolean;
  databaseFiles(): readonly string[];
  deleteDatabaseFiles(): void;
  keyStoreFilesExist(): boolean;
  deleteKeyStoreFiles(): void;
  deleteKek(): Promise<void>;
}

/** What `discardWithoutDbKey` deleted; `kek` settles when the key-encryption key is gone too. */
export interface DiscardedLeftovers {
  readonly databaseFiles: number;
  readonly keyStoreFiles: boolean;
  readonly kek: Promise<void>;
}

/**
 * At boot, before the database key is created: without it no database can be read, and nothing under
 * `keys/` belongs to a working install either (the key is created before anything is sealed). So these
 * are an interrupted wipe's leftovers (or a restore without the Keychain): the database files and
 * `keys/` are deleted here, synchronously, and the key-encryption key's delete is returned, to be
 * awaited before the KeyStore is used (it would otherwise seal under a key the delete then removes).
 * Undefined when the key exists or nothing was left.
 */
export function discardWithoutDbKey(io: WipeLeftovers): DiscardedLeftovers | undefined {
  if (io.dbKeyExists()) return undefined;
  const databaseFiles = io.databaseFiles().length;
  const keyStoreFiles = io.keyStoreFilesExist();
  if (databaseFiles === 0 && !keyStoreFiles) return undefined;
  if (databaseFiles > 0) io.deleteDatabaseFiles();
  if (keyStoreFiles) io.deleteKeyStoreFiles();
  return { databaseFiles, keyStoreFiles, kek: Promise.resolve().then(() => io.deleteKek()) };
}
