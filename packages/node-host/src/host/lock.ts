// The machine lock: one host per data dir. `<run>/host.lock.db` is opened with node:sqlite,
// `busy_timeout 0`, and `BEGIN EXCLUSIVE` is held for the host's whole life. That is an OS file lock
// (fcntl on POSIX, LockFileEx on Windows) the OS releases when the process dies, however it dies, so
// there is no stale lock and no pid-reuse hazard (Node has no flock; an O_EXCL pid file can go stale).
// Only the holder unlinks and binds the socket, so a stale-socket takeover cannot race.
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

  constructor(key: typeof KEY, path: string, db: DatabaseSync) {
    if (key !== KEY) throw new TypeError("a HostLock comes from acquireHostLock only");
    this.path = path;
    this.#db = db;
  }

  get held(): boolean {
    return this.#db !== undefined;
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
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("BEGIN EXCLUSIVE");
  } catch (error) {
    db.close();
    if ((error as { errcode?: unknown }).errcode === SQLITE_BUSY) return undefined;
    throw error;
  }
  return new HostLock(KEY, path, db);
}
