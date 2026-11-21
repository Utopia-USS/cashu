// When the host may run a relay pass for one vault (M4-C section 2). Pure: the clock is a parameter.
//   - a pull waits at least 60 s after the previous pass started; the pull timer's own pulls
//     (`"tick"`: every 60 s while the vault has another member, else every 5 minutes, `relayPullDue`)
//     keep only the timer's spacing after the timer's previous pull (a tick a millisecond early never
//     skips a whole minute), so any other pull (`requestPull`, pairing) still waits the full 60 s,
//   - a watch pull (a pairing waits for the new phone's first sync) at most every 5 s,
//   - a push (2 s after own writes) and the pass at vault open run at once,
//   - after a failure those passes wait out a back-off: 60 s doubling to 30 min when the relay is
//     unreachable or refuses, 1 h when its quota is exhausted. Reads (list, read) and writes (append)
//     are judged apart: a success resets only the failures of its own direction, and the back-off ends
//     early only when neither direction is failing. So a relay that answers reads while every append
//     times out (a slow uplink) still doubles the back-off up to its cap instead of retrying the doomed
//     append every 60 s,
//   - the final push before the idle exit ignores the back-off: it is one bounded attempt, and the
//     writes it carries would otherwise wait for the next host start.
// The policy also remembers WHY the back-off runs (errors.ts `TransportUnavailableReason`): the gate
// that refuses callers during it answers with the same reason, so a refusal (this Mac removed, its
// identity lost) never reads as an outage to the fetch lease (G1).
import type { TransportUnavailableReason } from "@cashu/sync";

/** The pull spacing of a vault no other device uses (nothing at the relay changes but this Mac's own). */
export const RELAY_PULL_INTERVAL_MS = 5 * 60_000;
/**
 * The pull spacing while the vault has at least one member besides this Mac (a phone): there are no
 * push notifications, so this bounds how late the Mac sees a change made on the phone (was up to
 * 5 minutes; measured 250 s in a real run). Cost per shared vault (one Mac + one phone) with the host
 * running 12 hours a day: 720 pulls of an unchanged vault at 2 to 3 reads each, the member-list read
 * that follows a pass included (measured in service.integration.test.ts), is about 1,440 to 2,160 reads
 * a day; 2,880 (4 reads a pull) is the upper bound, under 6% of the free plan's 50,000 reads a day
 * (about 576 at 5 minutes). A host running 24 hours doubles each figure.
 */
export const RELAY_SHARED_PULL_INTERVAL_MS = 60_000;
export const RELAY_MIN_PULL_GAP_MS = 60_000;
export const RELAY_PUSH_DEBOUNCE_MS = 2_000;
/** The pull spacing while a pairing of the vault waits for the new phone's first sync. */
export const RELAY_WATCH_PULL_MS = 5_000;
/** How long after the admission those fast pulls run at most; the normal schedule then takes over. */
export const RELAY_WATCH_MAX_MS = 3 * 60_000;
export const RELAY_BACKOFF_START_MS = 60_000;
export const RELAY_BACKOFF_MAX_MS = 30 * 60_000;
export const RELAY_QUOTA_BACKOFF_MS = 60 * 60_000;
/** The final push before the idle exit: one attempt, at most this long (launchd allows 20 s). */
export const RELAY_FINAL_PUSH_TIMEOUT_MS = 10_000;

/** Why a pass is wanted (`tick`: a pull of the pull timer, `pull`: any other pull request). */
export type RelayPassReason = "open" | "push" | "pull" | "tick" | "watch" | "final";

/** How a pass that did not reach the relay cleanly failed. */
export type RelayFailure = "unavailable" | "quota";

/** Which side of the relay a call used: `list` / `read`, or `append`. */
export type RelayDirection = "read" | "write";

/**
 * Whether the pull timer's `tick`-th tick (it ticks every RELAY_SHARED_PULL_INTERVAL_MS from the host
 * start, the first tick is 1) pulls a vault: every tick while another device is a member of it, else
 * every 5th tick (5 minutes, the old schedule exactly).
 */
export function relayPullDue(tick: number, shared: boolean): boolean {
  return shared || tick % (RELAY_PULL_INTERVAL_MS / RELAY_SHARED_PULL_INTERVAL_MS) === 0;
}

export class RelayPolicy {
  #lastStartAt: number | undefined;
  /** The previous pass was a pull of the timer: the timer's next pull keeps its spacing, not the gap. */
  #lastWasTick = false;
  /** Consecutive failures per direction (a success resets only its own). */
  readonly #failures: Record<RelayDirection, number> = { read: 0, write: 0 };
  #blockedUntil = 0;
  #reason: TransportUnavailableReason = "outage";
  /** The running back-off was armed by an exhausted quota. */
  #quota = false;

  /** The earliest time a pass for `reason` may start (`now` or later). */
  nextAt(reason: RelayPassReason, now: number): number {
    if (reason === "final") return now;
    let at = Math.max(now, this.#blockedUntil);
    const pull = reason === "pull" || reason === "tick";
    const timerSpaced = reason === "tick" && this.#lastWasTick;
    if (pull && this.#lastStartAt !== undefined && !timerSpaced)
      at = Math.max(at, this.#lastStartAt + RELAY_MIN_PULL_GAP_MS);
    if (reason === "watch" && this.#lastStartAt !== undefined)
      at = Math.max(at, this.#lastStartAt + RELAY_WATCH_PULL_MS);
    return at;
  }

  allows(reason: RelayPassReason, now: number): boolean {
    return this.nextAt(reason, now) <= now;
  }

  started(now: number, reason?: RelayPassReason): void {
    this.#lastStartAt = now;
    this.#lastWasTick = reason === "tick";
  }

  /**
   * A call of `direction` was answered. The back-off (and its reason) ends only when the other
   * direction is not failing either: a successful read never cancels a back-off a failing write armed.
   */
  succeeded(direction: RelayDirection): void {
    this.#failures[direction] = 0;
    if (this.#failures.read > 0 || this.#failures.write > 0) return;
    this.#blockedUntil = 0;
    this.#reason = "outage";
    this.#quota = false;
  }

  /** The cause of the back-off is gone (this Mac reconnected): the next pass may start at once. */
  reset(): void {
    this.#failures.read = 0;
    this.#failures.write = 0;
    this.succeeded("read");
  }

  failed(
    kind: RelayFailure,
    now: number,
    reason: TransportUnavailableReason,
    direction: RelayDirection,
  ): void {
    this.#reason = reason;
    this.#quota = kind === "quota";
    if (kind === "quota") {
      this.#blockedUntil = now + RELAY_QUOTA_BACKOFF_MS;
      return;
    }
    this.#failures[direction] += 1;
    const delay = Math.min(
      RELAY_BACKOFF_MAX_MS,
      RELAY_BACKOFF_START_MS * 2 ** Math.min(this.#failures[direction] - 1, 16),
    );
    this.#blockedUntil = now + delay;
  }

  /** When the back-off of the last failure ends (0 when none is running). */
  get blockedUntil(): number {
    return this.#blockedUntil;
  }

  /** When the quota back-off ends; undefined unless the running back-off is the quota's. */
  quotaUntil(now: number): number | undefined {
    return this.#quota && this.#blockedUntil > now ? this.#blockedUntil : undefined;
  }

  /** Why the last failure happened (`outage` when none did). */
  get blockedReason(): TransportUnavailableReason {
    return this.#reason;
  }
}
