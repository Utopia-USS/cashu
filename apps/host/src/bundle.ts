// Bundle-swap detection (port of the Python `runtime.bundle_replaced`): the host stamps a file of the
// bundle it was started from (the installed app's Info.plist; in dev the host's entry file) by inode,
// size and mtime, and checks it on a timer. When an update replaced the bundle the host hands over:
// it stops taking work, finishes the queued writes, closes its stores, releases the lock and exits 75,
// so the service manager (or the next client) starts the new bundle. Never loads code from the new
// bundle itself.
import { statSync } from "node:fs";

export const HANDOVER_EXIT = 75;

/** The file's identity, or undefined when it is gone (a swap in progress counts as replaced). */
function bundleStamp(path: string): string | undefined {
  try {
    const st = statSync(path);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return undefined;
  }
}

/** Calls `onReplaced` once when `path` no longer has the identity it had now. Returns the stop. */
export function watchBundle(path: string, intervalMs: number, onReplaced: () => void): () => void {
  const initial = bundleStamp(path);
  const timer = setInterval(() => {
    if (bundleStamp(path) === initial) return;
    clearInterval(timer);
    onReplaced();
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
