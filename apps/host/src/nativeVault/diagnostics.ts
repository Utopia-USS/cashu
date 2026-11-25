// Diagnostics for native vault refusals. A refusal stays the same outward code; the cause goes to
// stderr, which the detached host process sends to host.log (same channel as devices/leaseAttempts).
// Only the error class name and a short snake_case code are written: never a message that may quote
// a value, a key, a phrase word or a path.
import { errorCode as causeCode } from "@cashu/host-protocol/startup-failure";
import { errorName } from "../log.js";

/** Writes why a native vault operation was refused or ended unknown. Best effort, never throws. */
export function warnCause(event: string, error: unknown): void {
  try {
    console.warn(event, errorName(error), causeCode(error));
  } catch {
    // Logging is best effort: a broken stderr must not change the refusal it explains.
  }
}

/**
 * The same, once per session and cause, for predicates polled on every request (`isCurrent`,
 * `canRunSideEffects`): the first occurrence explains the state without flooding the log.
 */
export function onceWarner(): (event: string, error: unknown) => void {
  const seen = new Set<string>();
  return (event, error) => {
    const key = `${event}:${errorName(error)}:${causeCode(error)}`;
    if (seen.has(key)) return;
    seen.add(key);
    warnCause(event, error);
  };
}
