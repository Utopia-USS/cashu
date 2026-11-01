// TRANSITIONAL(S49): the lab / dev host of the outbox bridge (S31a spec 2.2).
//
// Single instance per Python data dir: an exclusive lockfile `<stateRoot>/daemon.lock` (O_EXCL, the
// holder's pid inside). A lock whose pid is not alive is stale and taken over; a live one refuses.
import { closeSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";

export class LockedError extends Error {
  readonly exitCode = 64;
  constructor() {
    super("another daemon holds the lock of this state root");
    this.name = "LockedError";
  }
}

/** Whether a process with `pid` exists (signal 0). */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
}

export interface Lock {
  release(): void;
}

/** Takes the lock at `path` for `pid`; takes over a stale one once. */
export function acquireLock(path: string, pid: number, alive = pidAlive): Lock {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(pid));
      closeSync(fd);
      return { release: () => rmSync(path, { force: true }) };
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      const holder = Number(readFileSync(path, "utf8").trim());
      if (Number.isSafeInteger(holder) && holder > 0 && alive(holder)) throw new LockedError();
      rmSync(path, { force: true }); // stale: the holder is gone
    }
  }
  throw new LockedError();
}
