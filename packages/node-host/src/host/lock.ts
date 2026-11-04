// The machine lock: one host per data dir. `<run>/host.lock.db` is opened with node:sqlite,
// `busy_timeout 0`, and `BEGIN EXCLUSIVE` is held for the host's whole life. That is an OS file lock
// (fcntl on POSIX, LockFileEx on Windows) the OS releases when the process dies, however it dies, so
// there is no stale lock and no pid-reuse hazard (Node has no flock; an O_EXCL pid file can go stale).
// Only the holder unlinks and binds the socket, so a stale-socket takeover cannot race.

import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const SQLITE_BUSY = 5;
const KEY = Symbol("HostLock");

/**
 * Proof that this process is the data dir's single writer. Only `acquireHostLock` makes one, so code
 * that opens a vault DB for writing can require it (the `exclusive` option of `openNodeSqlite`).
 */
export class HostLock {
  readonly path: string;
  #db: DatabaseSync | undefined;
  readonly #device: number;
  readonly #inode: number;

  constructor(key: typeof KEY, path: string, db: DatabaseSync, device: number, inode: number) {
    if (key !== KEY) throw new TypeError("a HostLock comes from acquireHostLock only");
    this.path = path;
    this.#db = db;
    this.#device = device;
    this.#inode = inode;
  }

  get held(): boolean {
    if (this.#db === undefined) return false;
    try {
      const stat = lstatSync(this.path);
      return (
        stat.isFile() &&
        !stat.isSymbolicLink() &&
        stat.nlink === 1 &&
        stat.dev === this.#device &&
        stat.ino === this.#inode &&
        (stat.mode & 0o777) === 0o600 &&
        (typeof process.getuid !== "function" || stat.uid === process.getuid())
      );
    } catch {
      return false;
    }
  }

  /** Releases the lock (idempotent). The host unlinks its socket and discovery file first. */
  release(): void {
    const db = this.#db;
    if (db === undefined) return;
    this.#db = undefined;
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  }
}

/** Takes the lock at `path`, or returns undefined when another process (or connection) holds it. */
export function acquireHostLock(path: string): HostLock | undefined {
  try {
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    (before.mode & 0o777) !== 0o600 ||
    (typeof process.getuid === "function" && before.uid !== process.getuid())
  )
    throw new Error("host_lock_path_invalid");
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
    const after = lstatSync(path);
    if (after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1)
      throw new Error("host_lock_path_invalid");
  } catch (error) {
    db.close();
    if ((error as { errcode?: unknown }).errcode === SQLITE_BUSY) return undefined;
    throw error;
  }
  return new HostLock(KEY, path, db, before.dev, before.ino);
}
