import { randomBytes } from "node:crypto";
import type { Stats } from "node:fs";
// Sealed key blobs (`<data dir>/<root>/v1/<name>.bin`, sealed with a KEK from the OS keyring): the vault
// keys (`vault-secrets`), and on Windows the banking and connector secrets (`sealed.ts`).
// Every directory on the way must be a real directory and every blob a regular file with one link,
// reached without a symlink (a link in place of a blob, dangling or not, is refused, never read as
// "no blob"); on macOS / Linux also mode 0700 / 0600 of this user. Windows reports
// synthetic modes and owners, so there those two checks are skipped and the data dir's per-user ACL
// (%LOCALAPPDATA%) carries them; directory fsyncs are no-ops there (`../host/privateFs.ts`).
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { crypto } from "@cashu/sync";
import { existingRealPath } from "../guard.js";
import {
  hasPrivateMode,
  O_NOFOLLOW,
  O_NONBLOCK,
  openedWithoutLink,
  syncDirectory as syncDirectoryEntries,
} from "../host/privateFs.js";

const MAX_BLOB = 1024 * 1024;
const VERSION_CHILD = "v1";

/**
 * The directory under the data dir that holds one kind of sealed blob: the vault keys everywhere, and
 * on Windows the banking and connector secrets too (`sealed.ts`).
 */
export type PrivateBlobRoot = "vault-secrets" | "banking-secrets" | "connector-secrets";

function failure(): never {
  throw new crypto.CryptoError("keystore_unavailable");
}
function corrupt(): never {
  throw new crypto.CryptoError("keystore_corrupt");
}
function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (absent(error)) return false;
    failure();
  }
}
function privateDirectory(path: string): void {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    failure();
  }
  if (!st.isDirectory() || st.isSymbolicLink() || !hasPrivateMode(st, 0o700)) failure();
}
function privateFile(path: string): void {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch {
    failure();
  }
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.nlink !== 1 ||
    !hasPrivateMode(st, 0o600) ||
    st.size > MAX_BLOB
  )
    corrupt();
}
function syncDirectory(path: string): void {
  try {
    syncDirectoryEntries(path);
  } catch {
    failure();
  }
}

/** Fixed private root under an existing canonical data directory. Never repairs unsafe permissions. */
export class PrivateBlobFiles implements crypto.BlobFiles {
  readonly #dataDir: string;
  readonly #parent: string;
  readonly #root: string;
  readonly #create: boolean;
  constructor(dataDir: string, create: boolean, root: PrivateBlobRoot = "vault-secrets") {
    let canonical: string;
    try {
      canonical = existingRealPath(dataDir);
    } catch {
      failure();
    }
    if (resolve(dataDir) !== dataDir || canonical !== dataDir) failure();
    privateDirectory(dataDir);
    this.#dataDir = dataDir;
    this.#parent = join(dataDir, root);
    this.#root = join(this.#parent, VERSION_CHILD);
    this.#create = create;
  }
  #checkRoot(create = false): boolean {
    let canonical: string;
    try {
      canonical = existingRealPath(this.#dataDir);
    } catch {
      failure();
    }
    if (canonical !== this.#dataDir) failure();
    privateDirectory(this.#dataDir);
    if (!present(this.#parent)) {
      if (!create || !this.#create) return false;
      try {
        mkdirSync(this.#parent, { mode: 0o700 });
      } catch {
        failure();
      }
      privateDirectory(this.#parent);
      syncDirectory(this.#dataDir);
    }
    privateDirectory(this.#parent);
    if (!present(this.#root)) {
      if (!create || !this.#create) return false;
      try {
        mkdirSync(this.#root, { mode: 0o700 });
      } catch {
        failure();
      }
      privateDirectory(this.#root);
      syncDirectory(this.#parent);
    }
    privateDirectory(this.#root);
    return true;
  }
  #path(name: string): string {
    crypto.checkName(name);
    return join(this.#root, `${name}.bin`);
  }
  hasAnyBlob(): boolean {
    if (!this.#checkRoot()) return false;
    try {
      return readdirSync(this.#root).length > 0;
    } catch {
      failure();
    }
  }
  async read(name: string): Promise<Uint8Array | null> {
    const path = this.#path(name);
    if (!this.#checkRoot()) return null;
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    } catch (error) {
      // ENOENT is "no blob" only when nothing is there: Windows has no O_NOFOLLOW, so its open
      // follows a dangling link (or junction) to ENOENT where macOS / Linux refuse it (ELOOP).
      if (absent(error) && !present(path)) return null;
      failure();
    }
    try {
      privateFile(path);
      const st = fstatSync(fd);
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        st.size > MAX_BLOB ||
        !hasPrivateMode(st, 0o600) ||
        !openedWithoutLink(path, st)
      )
        corrupt();
      const bytes = readFileSync(fd);
      if (bytes.length !== st.size) corrupt();
      return new Uint8Array(bytes);
    } catch (error) {
      if (error instanceof crypto.CryptoError) throw error;
      failure();
    } finally {
      try {
        closeSync(fd);
      } catch {
        failure();
      }
    }
    return failure();
  }
  async write(name: string, value: Uint8Array, guard: () => void = () => undefined): Promise<void> {
    const path = this.#path(name);
    if (value.length > MAX_BLOB) corrupt();
    guard();
    this.#checkRoot(true);
    const current = await this.read(name);
    current?.fill(0);
    guard();
    this.#checkRoot();
    const temp = join(this.#root, `.tmp-${randomBytes(16).toString("hex")}`);
    let fd: number;
    try {
      fd = openSync(
        temp,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | O_NOFOLLOW,
        0o600,
      );
    } catch {
      failure();
    }
    try {
      privateFile(temp);
      let offset = 0;
      while (offset < value.length) {
        const written = writeSync(fd, value, offset, value.length - offset);
        if (written <= 0) failure();
        offset += written;
      }
      fsyncSync(fd);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        /* best effort temp cleanup */
      }
      if (error instanceof crypto.CryptoError) throw error;
      failure();
    } finally {
      try {
        closeSync(fd);
      } catch {
        failure();
      }
    }
    try {
      guard();
      this.#checkRoot();
      // Recheck the destination immediately before replacement.
      if (present(path)) privateFile(path);
      renameSync(temp, path);
      syncDirectoryEntries(this.#root);
      privateFile(path);
      const written = await this.read(name);
      if (!written || !Buffer.from(written).equals(Buffer.from(value))) corrupt();
      written.fill(0);
    } catch (error) {
      try {
        unlinkSync(temp);
      } catch {
        /* renamed or inaccessible */
      }
      if (error instanceof crypto.CryptoError) throw error;
      failure();
    }
  }
  async remove(name: string): Promise<void> {
    const path = this.#path(name);
    if (!this.#checkRoot()) return;
    if (!present(path)) return;
    try {
      privateFile(path);
      unlinkSync(path);
    } catch (error) {
      if (absent(error)) return;
      if (error instanceof crypto.CryptoError) throw error;
      failure();
    }
    syncDirectory(this.#root);
  }
}
