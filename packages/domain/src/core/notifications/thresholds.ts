// The numbers of the phone's notification rules (`composeNotifications`): each one named, tunable here.

/** At most this many "an alert you follow fired" notifications a day (each one groups every alert). */
export const ALERTS_PER_DAY = 3;

/** Stale bank data: a warning at each of these ages in hours; again only when the age reaches a higher rung. */
export const STALE_RUNGS_HOURS: readonly number[] = [36, 72, 168];

/** An ending bank permission: a warning when this many days or fewer are left, from the farthest rung in. */
export const CONSENT_RUNGS_DAYS: readonly number[] = [7, 1];

/** The evening digest's local hour. */
export const EVENING_HOUR = 19;

/** The weekly digest's weekday (0 = Sunday, as `Date.getDay`) ... */
export const WEEKLY_WEEKDAY = 0;

/** ... and its local hour. */
export const WEEKLY_HOUR = 18;

/** The month-closed digest's local hour on the 1st. */
export const MONTH_CLOSED_HOUR = 9;

/**
 * The month-closed digest goes out only while the following month is this many days old: a plan on the
 * 20th (a fresh install, a toggle turned on, a long absence) records it as sent without telling anyone.
 */
export const MONTH_CLOSED_DAYS = 7;

/** How many days ahead the weekly digest counts bills (daysUntil 1..7 from its fire date). */
export const NEXT_WEEK_DAYS = 7;

/**
 * A fresh install (no plan yet) tells only the marked alerts that opened within this many hours; older
 * open ones are recorded as told, so the first plan never pushes a week-old alert.
 */
export const FRESH_INSTALL_ALERT_HOURS = 24;

/** The told-alerts ledger forgets a closed signal after this many days ... */
export const NOTIFIED_ALERTS_DAYS = 30;

/** ... and keeps at most this many signals. */
export const NOTIFIED_ALERTS_MAX = 200;

/** A scheduled time closer than this to now counts as passed (the OS would deliver it late or never). */
export const SCHEDULE_MARGIN_MS = 60_000;
