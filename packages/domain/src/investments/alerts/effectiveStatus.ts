// Effective alert status at read time (events.md 8.7, S25 D-S1). The view stores the clock-free fold
// status (`muted > snoozed > triggered > active`: owner register first, then the evaluator's runtime
// register); expiry and the end of a snooze depend on the reader's clock, so they are applied here,
// never in the fold. Mirrors Python `service/alerts.py:housekeeping` (`<=` at both boundaries; a muted
// alert never expires there).
import { type DateTime, toStorage } from "../../dates.js";

/** The fold statuses the view stores. */
export type StoredAlertStatus = "active" | "triggered" | "muted" | "snoozed";
/** What a reader shows: the stored status, or `expired` once `expiresAt` passed. */
export type EffectiveAlertStatus = StoredAlertStatus | "expired";

export interface AlertStatusRow {
  readonly status: StoredAlertStatus;
  /** Timestamps as stored (`YYYY-MM-DD HH:MM:SS.ffffff`, naive UTC) or any ISO form with an offset. */
  readonly expires_at: string | null;
  readonly snoozed_until: string | null;
}

export interface EffectiveAlert {
  readonly status: EffectiveAlertStatus;
  /** `snoozed_until` as a reader sees it: null once the snooze ended or the alert expired. */
  readonly snoozed_until: string | null;
}

/**
 * The status and snooze end a reader shows at `now`: muted stays muted; an alert whose `expires_at`
 * is at or before `now` is expired; a snooze whose `snoozed_until` is at or before `now` reads as
 * active; otherwise the stored status.
 */
export function effectiveAlertStatus(row: AlertStatusRow, now: DateTime | string): EffectiveAlert {
  if (row.status === "muted") return { status: "muted", snoozed_until: row.snoozed_until };
  const at = toStorage(now);
  if (row.expires_at !== null && toStorage(row.expires_at) <= at) {
    return { status: "expired", snoozed_until: null };
  }
  if (
    row.status === "snoozed" &&
    row.snoozed_until !== null &&
    toStorage(row.snoozed_until) <= at
  ) {
    return { status: "active", snoozed_until: null };
  }
  return { status: row.status, snoozed_until: row.snoozed_until };
}
