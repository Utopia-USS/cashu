/** Owner write outcomes of the Signals screen mapped onto one notice vocabulary. */
import type { saveSignalGroup } from "@cashu/store/investments/signals-screen";
import type { GuardedOutcome } from "../useDurableCommand.js";

export type SignalsNotice =
  | "saved"
  | "skipped"
  | "partial"
  | "unknown"
  | "unavailable"
  | "previous_completed"
  | "previous_refused"
  | "failed"
  | "cleanup"
  | "cache"
  | "watch_warning"
  | "removed"
  | "restored";

export type GroupSaveOutcome = Awaited<ReturnType<typeof saveSignalGroup>>;
export type FailedOutcome = Exclude<GuardedOutcome<unknown>, { kind: "completed" }>;

/** A single guarded command that did not complete. */
export function guardedNotice(result: FailedOutcome): SignalsNotice {
  switch (result.kind) {
    case "outcome_unknown":
      return "unknown";
    case "not_started":
      return "unavailable";
    case "previous_completed":
    case "previous_refused":
      return result.kind;
    case "refused":
      return "failed";
  }
}

/** A sequential group save (decide the first signal, acknowledge the rest). */
export function groupNotice(outcome: GroupSaveOutcome): SignalsNotice {
  switch (outcome.status) {
    case "saved":
    case "skipped":
    case "partial":
    case "unknown":
    case "unavailable":
    case "previous_completed":
    case "previous_refused":
      return outcome.status;
    case "refused":
      return "failed";
  }
}

/** The refusal code a group save carries, if any. */
export function groupRefusal(outcome: GroupSaveOutcome): string | null {
  return outcome.status === "partial" || outcome.status === "refused" ? outcome.reason : null;
}

/**
 * A write that threw has an unconfirmed outcome. The cause is logged to the local console (it never
 * leaves the device) so the mapping to "unknown" does not swallow it silently.
 */
export function thrownNotice(scope: string, error: unknown): "unknown" {
  console.warn(`signals: ${scope} threw; the outcome is unconfirmed`, error);
  return "unknown";
}
