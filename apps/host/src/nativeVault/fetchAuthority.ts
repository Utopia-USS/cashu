// Fresh pull evidence for a fetch leader. The lease (packages/sync/src/devices/lease.ts) lets the
// pinned leader act only within the publish deadline after a pull, and requires that pull BEFORE
// each leader action. A vault used on one device has no peer whose carrier request would run a sync
// pass, so nothing else ever produces that evidence: every production fetch path asks for it here,
// right before it checks authority, instead of a timer polling idle vaults.
//
// Multi-device safety is unchanged: this only runs the vault's ordinary queued sync pass, and the
// authority check after it is the unchanged `canFetchPublicMarket` (lease, clock, catch-up). A pass
// is what lets the leader see a newer pin or a pending hand-over before it acts.
//
// Availability: a pass runs only for the named leader whose evidence is stale (never for another
// device, during a pending hand-over or with a suspect clock: a pass cannot fix those). A pass that
// produced no evidence (an offline remote, a failed pass) is retried only after a growing, capped
// back-off. A failed refresh pass does not close a verified session (nativeVault/sync.ts).
import type { NativeVaultContext } from "./context.js";
import { warnCause } from "./diagnostics.js";
import type { FetchLeaseState, SessionGuards } from "./guards.js";
import { REFRESH_PASS_FAILED, type SyncControl } from "./sync.js";
import type { FetchAuthorityIssue } from "./types.js";

/** First retry delay after a pass that produced no evidence; doubles per further miss. */
export const FETCH_PULL_BACKOFF_MS = 60_000;
/** The back-off never grows beyond this. */
export const FETCH_PULL_BACKOFF_MAX_MS = 30 * 60_000;
/** How long a refresh waits for a pass already running (carrier, UI) before it decides. */
const FETCH_PULL_SETTLE_WAIT_MS = 15_000;

export interface FetchAuthorityRefresh {
  /**
   * Runs one queued sync pass when this device is the named fetch leader, its pull evidence is
   * missing or older than half the publish deadline, and no back-off holds; then answers
   * `canFetchPublicMarket()`. A pass already running is awaited (bounded) first. Never throws.
   * Concurrent callers share one pass. MUST NOT be awaited inside the vault's write queue: the pass
   * is queued behind the caller.
   */
  refreshFetchAuthority(): Promise<boolean>;
  /** Fetch authority now, or after the pass `refreshFetchAuthority` would run (status only). */
  mayObtainFetchAuthority(): boolean;
  fetchAuthorityIssue(): FetchAuthorityIssue | null;
}

export function fetchAuthorityRefresh(
  context: Pick<NativeVaultContext, "now">,
  guards: Pick<SessionGuards, "canFetchPublicMarket" | "fetchLeaseState">,
  control: Pick<SyncControl, "refreshPass" | "isSyncing" | "onSyncSettled">,
): FetchAuthorityRefresh {
  const { now } = context;
  let inFlight: Promise<boolean> | null = null;
  let misses = 0;
  let retryAt: number | undefined;
  let lastMiss: "fetch_pull_failed" | "fetch_pull_incomplete" = "fetch_pull_incomplete";
  const backingOff = () => {
    if (retryAt === undefined) return false;
    const at = now();
    // A clock that went backwards past the last miss does not freeze the back-off forever.
    return at < retryAt && retryAt - at <= FETCH_PULL_BACKOFF_MAX_MS;
  };
  const settled = () =>
    new Promise<void>((resolve) => {
      if (!control.isSyncing()) {
        resolve();
        return;
      }
      let off: () => void = () => {};
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, FETCH_PULL_SETTLE_WAIT_MS);
      timer.unref?.();
      off = control.onSyncSettled(done);
      if (!control.isSyncing()) done();
    });
  const missed = (failed: boolean) => {
    lastMiss = failed ? "fetch_pull_failed" : "fetch_pull_incomplete";
    const delay = Math.min(FETCH_PULL_BACKOFF_MS * 2 ** misses, FETCH_PULL_BACKOFF_MAX_MS);
    misses = Math.min(misses + 1, 16);
    retryAt = now() + delay;
  };
  const run = async (): Promise<boolean> => {
    // A pass already running (a carrier request, a UI sync) may bring the evidence: wait for it.
    if (control.isSyncing()) await settled();
    if (guards.fetchLeaseState() !== "pull_stale" || backingOff())
      return guards.canFetchPublicMarket();
    let failed = false;
    try {
      await control.refreshPass();
    } catch (error) {
      failed = true;
      // REFRESH_PASS_FAILED kept the session; anything else closed it (an authority failure).
      if (!(error instanceof Error && error.message === REFRESH_PASS_FAILED))
        warnCause("native_fetch_pull_closed", error);
    }
    if (failed || guards.fetchLeaseState() === "pull_stale") missed(failed);
    else {
      misses = 0;
      retryAt = undefined;
    }
    return guards.canFetchPublicMarket();
  };
  const refreshFetchAuthority = (): Promise<boolean> => {
    if (inFlight !== null) return inFlight;
    const pass = run()
      .catch((error: unknown) => {
        warnCause("native_fetch_pull_failed", error);
        return false;
      })
      .finally(() => {
        inFlight = null;
      });
    inFlight = pass;
    return pass;
  };
  const stateIssue = (state: FetchLeaseState): FetchAuthorityIssue | null => {
    switch (state) {
      case "unavailable":
        return "fetch_session_unavailable";
      case "not_leader":
        return "fetch_not_leader";
      case "handover_pending":
        return "fetch_handover_pending";
      case "clock_suspect":
        return "fetch_clock_suspect";
      case "pull_stale":
        return backingOff() ? lastMiss : null;
      case "pull_fresh":
        return "fetch_authority_unavailable";
    }
  };
  const fetchAuthorityIssue = (): FetchAuthorityIssue | null => {
    try {
      return guards.canFetchPublicMarket() ? null : stateIssue(guards.fetchLeaseState());
    } catch {
      return "fetch_authority_unavailable";
    }
  };
  return {
    refreshFetchAuthority,
    mayObtainFetchAuthority: () => fetchAuthorityIssue() === null,
    fetchAuthorityIssue,
  };
}
