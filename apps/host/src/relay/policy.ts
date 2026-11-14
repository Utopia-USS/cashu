// When the host may run a relay pass for one vault (M4-C section 2). Pure: the clock is a parameter.
//   - a pull (the 5-minute timer) waits at least 60 s after the previous pass started,
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

export const RELAY_PULL_INTERVAL_MS = 5 * 60_000;
export const RELAY_MIN_PULL_GAP_MS = 60_000;
export const RELAY_PUSH_DEBOUNCE_MS = 2_000;
export const RELAY_BACKOFF_START_MS = 60_000;
export const RELAY_BACKOFF_MAX_MS = 30 * 60_000;
export const RELAY_QUOTA_BACKOFF_MS = 60 * 60_000;
/** The final push before the idle exit: one attempt, at most this long (launchd allows 20 s). */
export const RELAY_FINAL_PUSH_TIMEOUT_MS = 10_000;

/** Why a pass is wanted. */
export type RelayPassReason = "open" | "push" | "pull" | "final";

/** How a pass that did not reach the relay cleanly failed. */
export type RelayFailure = "unavailable" | "quota";

/** Which side of the relay a call used: `list` / `read`, or `append`. */
export type RelayDirection = "read" | "write";

export class RelayPolicy {
  #lastStartAt: number | undefined;
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
    if (reason === "pull" && this.#lastStartAt !== undefined)
      at = Math.max(at, this.#lastStartAt + RELAY_MIN_PULL_GAP_MS);
    return at;
  }

  allows(reason: RelayPassReason, now: number): boolean {
    return this.nextAt(reason, now) <= now;
  }

  started(now: number): void {
    this.#lastStartAt = now;
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
