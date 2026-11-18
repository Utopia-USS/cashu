// Removal of a test's temp directory on every platform (tests only).
import { rmSync } from "node:fs";

/**
 * Removes a test's temp directory and everything in it. Windows refuses to delete a file another
 * handle still has open (a host or SQLite connection that is just closing) with EBUSY / EPERM; Node's
 * own retry (`maxRetries`, linear backoff) rides that out. macOS and Linux never retry.
 */
export function removeTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
