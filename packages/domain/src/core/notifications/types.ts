// The phone's notifications as data: what the planner counts (`NotificationInput`), what the user chose
// (`NotificationPrefs`), what was already sent (`NotificationLedger`) and what to send
// (`NotificationMessage`, numbers and enum values only: never an amount, a payee or a name).

/** The grouping key of a notification and its rule. */
export type NotificationKind =
  // When the phone next syncs.
  | "alerts_fired"
  | "device_change"
  // Digests.
  | "evening"
  | "weekly"
  | "month_closed"
  // Warnings, once (again only when worse).
  | "stale_data"
  | "consent_ending";

/** The owner runs the profile (fixes stale data, bank permissions, alerts); a partner only follows it. */
export type ProfileRole = "owner" | "partner";

/** A calendar month, "YYYY-MM": the only text a notification message carries besides its kind. */
export type YearMonth = `${number}-${number}`;

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/u;

/** True for a valid "YYYY-MM". */
export function isYearMonth(value: string): value is YearMonth {
  return YEAR_MONTH.test(value);
}

/** The user's notification choices for one vault on this phone. */
export interface NotificationPrefs {
  /** An alert marked "tell my phone" fired (owner only). */
  readonly alertsFired: boolean;
  /** A device joined or left the profile: always on, for safety. */
  readonly deviceChanges: true;
  readonly weekly: boolean;
  readonly monthClosed: boolean;
  readonly evening: boolean;
  /** Bank data getting old (owner only; a partner sees it in the app, never as a push). */
  readonly staleData: boolean;
  /** A bank permission ending soon (owner only). */
  readonly consentEnding: boolean;
}

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  alertsFired: false,
  deviceChanges: true,
  weekly: true,
  monthClosed: true,
  evening: false,
  staleData: true,
  consentEnding: true,
};

/** One open alert signal: one firing of an alert, as the planner reads it. */
export interface OpenAlertSignal {
  /** The signal's gid (one firing; the same alert firing again later is a new signal). */
  readonly signal: string;
  /** ISO instant the signal opened (the leader's evaluation time, so it can predate the last plan). */
  readonly firstSeenAt: string;
  /** Its alert is marked "tell my phone" on this phone. */
  readonly marked: boolean;
}

/** Everything one plan run reads, counts only (the planner builds it from the vault and the device). */
export interface NotificationInput {
  readonly vault: string;
  readonly role: ProfileRole;
  /** The profile's name in the title ("cashU · Anna") when the phone holds 2+ profiles, else null ("cashU"). */
  readonly profileLabel: string | null;
  readonly modules: readonly string[];
  /** ISO instant. */
  readonly now: string;
  /** YYYY-MM-DD, the device's local day. */
  readonly today: string;
  /** IANA zone the fire times are computed in. */
  readonly timeZone: string;
  /**
   * Every open alert signal still waiting for the owner (an action without a decision, not snoozed, not
   * research), marked or not: the composer tells the marked ones it has not told yet and records every
   * one it has seen, so an alert marked after it fired never pushes.
   */
  readonly alerts: readonly OpenAlertSignal[];
  readonly devices: { readonly joined: number; readonly left: number };
  readonly bills: {
    readonly dueTomorrow: number;
    /** Bills with daysUntil 1..7 from the weekly digest's fire date. */
    readonly nextWeek: number;
  };
  /** Uncategorized payments in the running month. */
  readonly toCategorize: number;
  readonly reviewDue: boolean;
  /** Proposals waiting on the Mac. */
  readonly waitingOnMac: number;
  /** The previous month, "YYYY-MM", and whether its figures are in; null when the planner did not read it. */
  readonly monthClosed: {
    readonly month: string;
    readonly complete: boolean;
  } | null;
  readonly freshness: {
    readonly bankDataAgeHours: number | null;
    readonly consentEndsInDays: { readonly days: number } | null;
  };
}

/** What was already sent for one vault: written back by the planner after scheduling succeeded. */
export interface NotificationLedger {
  readonly lastPlannedAt: string | null;
  /** YYYY-MM-DD -> alert notifications sent that day (the last 7 days are kept). */
  readonly alertsSentOn: Readonly<Record<string, number>>;
  /**
   * Signal gid -> YYYY-MM-DD it was first seen by a plan: told (marked), or recorded without a push
   * (unmarked, capped, older than the fresh-install look-back, the toggle off). A signal in here never
   * pushes again. Pruned to `NOTIFIED_ALERTS_DAYS` / `NOTIFIED_ALERTS_MAX`; an open signal is never pruned
   * by age.
   */
  readonly notifiedAlerts: Readonly<Record<string, string>>;
  /** Index into `STALE_RUNGS_HOURS` of the last stale warning, null while the data is fresh. */
  readonly staleRung: number | null;
  /** Index into `CONSENT_RUNGS_DAYS` of the last permission warning, null while none is ending. */
  readonly consentRung: number | null;
  /** YYYY-MM of the last month-closed digest. */
  readonly monthClosedSentFor: string | null;
  /** YYYY-MM-DD (the Sunday) of the last weekly digest. */
  readonly weeklySentFor: string | null;
  /** YYYY-MM-DD of the last evening digest. */
  readonly eveningSentFor: string | null;
}

export const EMPTY_NOTIFICATION_LEDGER: NotificationLedger = {
  lastPlannedAt: null,
  alertsSentOn: {},
  notifiedAlerts: {},
  staleRung: null,
  consentRung: null,
  monthClosedSentFor: null,
  weeklySentFor: null,
  eveningSentFor: null,
};

/** What a notification says: numbers and enums only. The phone renders text from a catalog. */
export type NotificationMessage =
  | { readonly kind: "alerts_fired"; readonly count: number }
  | { readonly kind: "device_change"; readonly joined: number; readonly left: number }
  | { readonly kind: "evening"; readonly billsTomorrow: number; readonly toCategorize: number }
  | {
      readonly kind: "weekly";
      readonly billsNextWeek: number;
      readonly reviewDue: boolean;
      readonly waitingOnMac: number;
    }
  /** `month` is rendered as a month name. */
  | { readonly kind: "month_closed"; readonly month: YearMonth; readonly hasPlan: boolean }
  | { readonly kind: "stale_data"; readonly ageHours: number }
  | { readonly kind: "consent_ending"; readonly days: number };

export interface PlannedNotification {
  /** Deterministic: `${vault}.${kind}.${local fire date or "now"}`; the same plan re-run gives the same id. */
  readonly id: string;
  readonly vault: string;
  readonly profileLabel: string | null;
  readonly message: NotificationMessage;
  /** ISO instant in the future, or null = deliver now. */
  readonly fireAt: string | null;
  /** Grouping key (threadIdentifier). */
  readonly thread: NotificationKind;
}

/**
 * One plan run's result. `notifications` is the complete set this vault should have pending or deliver
 * now: a digest already scheduled by an earlier run comes again with the same id while its time is
 * still ahead, so the planner may replace every pending notification of the vault with this set.
 */
export interface NotificationPlan {
  readonly notifications: readonly PlannedNotification[];
  /** The ledger after this plan (the planner persists it when scheduling succeeded). */
  readonly ledger: NotificationLedger;
}
