// The writer lease: proof that this process is the data dir's single writer. It wraps the machine lock
// (`run/host.lock.db`, held for the host's life, released by the OS when the process dies) and is the
// only way to open a store file for writing here (exclusive SQLite open, `stores.ts`). Every write
// task checks it right before it runs, so a host that lost its lock (closing) writes nothing more.
import type { HostLock } from "@cashu/node-host";

const KEY = Symbol("WriterLease");

class LeaseLostError extends Error {
  constructor() {
    super("the writer lease is no longer held");
    this.name = "LeaseLostError";
  }
}

export class WriterLease {
  readonly #lock: HostLock;

  constructor(key: typeof KEY, lock: HostLock) {
    if (key !== KEY) throw new TypeError("a WriterLease comes from takeWriterLease only");
    this.#lock = lock;
  }

  get held(): boolean {
    return this.#lock.held;
  }

  /** The held machine lock, for `openNodeSqlite(path, { exclusive })`. Throws when it was released. */
  lock(): HostLock {
    this.assertHeld();
    return this.#lock;
  }

  assertHeld(): void {
    if (!this.#lock.held) throw new LeaseLostError();
  }
}

/** The lease of a host that holds the machine lock (`RunningHost.lock`). */
export function takeWriterLease(lock: HostLock): WriterLease {
  if (!lock.held) throw new LeaseLostError();
  return new WriterLease(KEY, lock);
}
