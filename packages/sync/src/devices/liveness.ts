// Liveness of the pinned fetch leader (S29c R4, lead decision): a pinned leader that died or lost its
// bank session stops PSD2 fetching for the whole vault until the owner re-pins. Every device computes
// from the log (the leader's `lease.fetched` reports, else the pin that made it leader) and its own
// injected clock whether the leader has been silent for more than 36 hours, plus what the S44 UI
// needs to show the warning with the re-pin action (crypto/README.md "S29c: the pinned fetch leader").
// Pure: no wall clock here; `now` and `firstSeen` come from the caller.

import type { LeaseView } from "./leaseFold.js";
import type { Registry } from "./registry.js";
import { cmp } from "./util.js";

/** Warn once the pinned leader has not reported a fetch for longer than this. */
export const LEADER_SILENCE_WARNING_MS = 36 * 60 * 60 * 1000;

export type LeaderState =
  /** The leader reported a fetch (or was pinned) within the warning period. */
  | "ok"
  /** The leader has been silent for longer than the warning period. */
  | "silent"
  /** No trusted leader (none pinned, or it was revoked): nobody fetches. */
  | "leaderless"
  /** A re-pin waits for the previous leader's acknowledgement. */
  | "handover_pending"
  /** Mode auto: any eligible device takes over by itself; no pinned leader to watch. */
  | "auto";

export interface RepinAction {
  /** Trusted devices the owner may pin instead (the current leader excluded), sorted. */
  readonly candidates: readonly string[];
  /**
   * The re-pin has to be forced to take effect without an acknowledgement from `mayStillRun` (D4:
   * offer the safe path first: wait, revoke that device, or pin from it).
   */
  readonly force: boolean;
  /** The device the force warning names ("if it is still running, it may fetch once more"). */
  readonly mayStillRun: string | null;
}

export interface LeaderLiveness {
  readonly mode: "pinned" | "auto";
  readonly state: LeaderState;
  /** The pinned leader (null in mode auto or when none is pinned). */
  readonly leader: string | null;
  readonly pendingFrom: string | null;
  /** The event the silence is measured from: the leader's last fetch report, else its pin. */
  readonly since: { readonly eid: string; readonly kind: "fetched" | "pinned" } | null;
  /**
   * When that happened as far as this device can tell: the writer's `at`, but never later than when
   * this device first saw the event (a leader whose clock runs ahead cannot look fresh).
   */
  readonly lastActivityAt: number | undefined;
  readonly silentForMs: number;
  /** Show the warning (S44): leaderless, or silent / stuck in a hand-over beyond the period. */
  readonly warn: boolean;
  /** The re-pin the warning offers (null in mode auto). */
  readonly repin: RepinAction | null;
}

export interface LivenessLocal {
  readonly now: number;
  readonly firstSeen: (eid: string) => number | undefined;
}

export function leaderLiveness(
  view: LeaseView,
  registry: Registry,
  local: LivenessLocal,
  warnAfterMs: number = LEADER_SILENCE_WARNING_MS,
): LeaderLiveness {
  if (view.mode === "auto") {
    return {
      mode: "auto",
      state: "auto",
      leader: null,
      pendingFrom: view.pendingFrom,
      since: null,
      lastActivityAt: undefined,
      silentForMs: 0,
      warn: false,
      repin: null,
    };
  }
  const leader = view.pinned;
  const since = view.lastFetch
    ? { eid: view.lastFetch.eid, kind: "fetched" as const, at: view.lastFetch.at }
    : view.pin
      ? { eid: view.pin.eid, kind: "pinned" as const, at: view.pin.at }
      : null;
  const lastActivityAt = since
    ? Math.min(since.at, local.firstSeen(since.eid) ?? since.at)
    : undefined;
  const silentForMs = lastActivityAt === undefined ? 0 : Math.max(0, local.now - lastActivityAt);
  const mustAck = view.pendingFrom ?? (view.free ? null : leader);
  const repin: RepinAction = {
    candidates: [...registry.trusted.keys()].filter((d) => d !== leader).sort(cmp),
    force: mustAck !== null && registry.isTrusted(mustAck),
    mayStillRun: mustAck,
  };
  const late = silentForMs > warnAfterMs;
  const state: LeaderState = view.free
    ? "leaderless"
    : view.pendingFrom !== null
      ? "handover_pending"
      : late
        ? "silent"
        : "ok";
  return {
    mode: "pinned",
    state,
    leader,
    pendingFrom: view.pendingFrom,
    since: since && { eid: since.eid, kind: since.kind },
    lastActivityAt,
    silentForMs,
    warn: state === "leaderless" || late,
    repin,
  };
}
