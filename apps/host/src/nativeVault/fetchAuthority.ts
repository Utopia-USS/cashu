// Fresh pull evidence for a fetch leader. The lease (packages/sync/src/devices/lease.ts) lets the
// pinned leader act only within the publish deadline after a pull, and requires that pull BEFORE
// each leader action. A vault used on one device has no peer whose carrier request would run a sync
// pass, so nothing else ever produces that evidence: every production fetch path asks for it here,
// right before it checks authority, instead of a timer polling idle vaults.
//
// Multi-device safety is unchanged: this only runs the vault's ordinary queued sync pass, and the
// authority check after it is the unchanged `canFetchPublicMarket` (lease, clock, catch-up). A pass
// is what lets the leader see a newer pin or a pending hand-over before it acts.
import type { NativeVaultContext } from "./context.js";
import { warnCause } from "./diagnostics.js";
import { FETCH_PULL_REFRESH_MS, type SessionGuards } from "./guards.js";
import type { SyncControl } from "./sync.js";

export interface FetchAuthorityRefresh {
  /**
   * Runs one queued sync pass when this device is the named fetch leader and its pull evidence is
   * missing or older than half the publish deadline, then answers `canFetchPublicMarket()`. Never
   * throws (a failed pass closes the session, as any sync failure does, and answers false).
   * Concurrent callers share one pass. MUST NOT be awaited inside the vault's write queue: the pass
   * is queued behind the caller.
   */
  refreshFetchAuthority(): Promise<boolean>;
}

export function fetchAuthorityRefresh(
  context: Pick<NativeVaultContext, "now">,
  guards: Pick<SessionGuards, "canFetchPublicMarket" | "fetchPullStale">,
  control: Pick<SyncControl, "sync">,
): FetchAuthorityRefresh {
  const { now } = context;
  let inFlight: Promise<boolean> | null = null;
  let lastAttemptAt: number | undefined;
  const refreshFetchAuthority = (): Promise<boolean> => {
    if (inFlight !== null) return inFlight;
    const at = now();
    // A pass that produced no evidence (an offline remote, a suspect clock) is not repeated within
    // the refresh window. A pass that did produce it pulled at or after `lastAttemptAt`, so this
    // never holds back a refresh the evidence needs.
    const recent =
      lastAttemptAt !== undefined &&
      at >= lastAttemptAt &&
      at - lastAttemptAt < FETCH_PULL_REFRESH_MS;
    if (recent || !guards.fetchPullStale()) return Promise.resolve(guards.canFetchPublicMarket());
    lastAttemptAt = at;
    const pass = control
      .sync()
      .then(
        () => undefined,
        (error: unknown) => warnCause("native_fetch_pull_failed", error),
      )
      .then(() => guards.canFetchPublicMarket())
      .finally(() => {
        inFlight = null;
      });
    inFlight = pass;
    return pass;
  };
  return { refreshFetchAuthority };
}
