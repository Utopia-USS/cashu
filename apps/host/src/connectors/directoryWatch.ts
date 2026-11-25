/** A debounced watch on one directory tree, so a host-owned live list follows changes made on disk. */
import { existsSync, watch } from "node:fs";
import { basename, dirname } from "node:path";

interface Watcher {
  on(event: "error", listener: (error: Error) => void): unknown;
  close(): void;
}
export type WatchFn = (
  path: string,
  options: { readonly recursive: boolean },
  listener: (event: string, name: string | Buffer | null) => void,
) => Watcher;

const nodeWatch: WatchFn = (path, options, listener) => watch(path, options, listener);

/**
 * Calls `changed` (debounced) after anything under `path` changes. A directory that does not exist yet
 * is awaited in its parent and watched from the moment it appears; one that disappears goes back to
 * that wait. Watching is best effort: a parent that is gone too (or a platform without file events)
 * leaves the list as it is, never failing the host. The returned function stops it for good.
 */
export function watchDirectory(
  path: string,
  changed: () => void,
  options: { readonly debounceMs?: number; readonly watch?: WatchFn } = {},
): () => void {
  const watchFn = options.watch ?? nodeWatch;
  const debounceMs = options.debounceMs ?? 150;
  let closed = false;
  let watcher: Watcher | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    if (closed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) changed();
    }, debounceMs);
    timer.unref?.();
  };
  const stopWatcher = () => {
    const current = watcher;
    watcher = undefined;
    try {
      current?.close();
    } catch {
      // Closing a watcher whose directory vanished may throw; it no longer reports anything.
    }
  };
  const start = (dir: string, recursive: boolean, onEvent: (name: string | null) => void) => {
    const next = watchFn(dir, { recursive }, (_event, name) =>
      onEvent(name === null ? null : String(name)),
    );
    next.on("error", () => {
      if (watcher !== next) return;
      stopWatcher();
      fire();
      arm();
    });
    watcher = next;
  };
  function arm(): void {
    if (closed) return;
    stopWatcher();
    if (existsSync(path)) {
      try {
        start(path, true, () => {
          fire();
          if (!existsSync(path)) arm();
        });
        return;
      } catch {
        // Removed between the check and the watch: wait for it below.
      }
    }
    const name = basename(path);
    try {
      start(dirname(path), false, (entry) => {
        if ((entry === null || entry === name) && existsSync(path)) {
          fire();
          arm();
        }
      });
    } catch {
      return;
    }
    // Created between the check above and the parent watch.
    if (existsSync(path)) {
      fire();
      arm();
    }
  }
  arm();
  return () => {
    closed = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    stopWatcher();
  };
}
