// A hosted command starts only between sync passes. While a native vault's session runs a pass (a
// fetch-lease refresh the worker asks for right after the host starts, a relay pull, a UI sync), its
// public reads refuse (stores.ts `NativeSessionUnavailableError`). The desktop store channel hides
// that by re-subscribing when the pass settles; a command reads once, so it waits for the passes that
// are running when it would start, bounded, and then starts in the same turn: a command that reads
// synchronously (most do) cannot meet a pass that starts later. A command still running when a later
// pass starts gets the typed refusal, which the runner turns into a clear "try again".
import type { HostStores } from "../stores.js";

/** The part of an open vault's native session the gate needs. */
export interface SyncingSession {
  isSyncing(): boolean;
  /** Calls `listener` when a pass settles; returns the unsubscribe. */
  onSyncSettled(listener: () => void): () => void;
}

/** The native sessions of the open vaults (a synthetic vault never syncs). */
export function* nativeSessions(stores: Pick<HostStores, "vaults">): Iterable<SyncingSession> {
  for (const vault of stores.vaults.values()) if (vault.native !== undefined) yield vault.native;
}

/** How long one command waits in total for passes to settle before it starts anyway. */
const CLI_SYNC_WAIT_MS = 15_000;

/**
 * Before a command: undefined when no session syncs (start now, in the same turn), else a promise
 * that resolves when the first syncing session settles, the signal aborts, or the wait budget runs out.
 * Call it again after each wait until it answers undefined. Once the budget ran out or the signal
 * aborted it always answers undefined. Never rejects.
 */
export type SyncGate = () => Promise<void> | undefined;

export function syncGate(
  sessions: () => Iterable<SyncingSession>,
  signal: AbortSignal,
  options: { readonly timeoutMs?: number; readonly now?: () => number } = {},
): SyncGate {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.timeoutMs ?? CLI_SYNC_WAIT_MS);
  return () => {
    if (signal.aborted) return undefined;
    const remaining = deadline - now();
    if (remaining <= 0) return undefined;
    let syncing: SyncingSession | undefined;
    for (const session of sessions()) {
      if (session.isSyncing()) {
        syncing = session;
        break;
      }
    }
    if (syncing === undefined) return undefined;
    const pass = syncing;
    return new Promise<void>((resolve) => {
      let finished = false;
      let off: () => void = () => {};
      const done = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        off();
        signal.removeEventListener("abort", done);
        resolve();
      };
      const timer = setTimeout(done, remaining);
      signal.addEventListener("abort", done, { once: true });
      off = pass.onSyncSettled(done);
    });
  };
}
