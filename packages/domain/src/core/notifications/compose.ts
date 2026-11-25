// The phone's notification rules (design/mobile/companion section 6): counts in, the notifications to
// deliver now or schedule out, plus the ledger that keeps warnings to "once, again only when worse" and
// alerts to a few a day. Pure and deterministic: the same inputs give the same ids and messages.
import { addDays, type IsoDate } from "../../dates.js";
import {
  eveningDigestOffset,
  isAhead,
  localDate,
  localFireAt,
  monthClosedDay,
  monthClosedFireAt,
  weeklyDigestOffset,
} from "./schedule.js";
import {
  ALERTS_PER_DAY,
  CONSENT_RUNGS_DAYS,
  EVENING_HOUR,
  FRESH_INSTALL_ALERT_HOURS,
  MONTH_CLOSED_DAYS,
  NOTIFIED_ALERTS_DAYS,
  NOTIFIED_ALERTS_MAX,
  STALE_RUNGS_HOURS,
  WEEKLY_HOUR,
} from "./thresholds.js";
import {
  isYearMonth,
  type NotificationInput,
  type NotificationLedger,
  type NotificationMessage,
  type NotificationPlan,
  type NotificationPrefs,
  type OpenAlertSignal,
  type PlannedNotification,
  type YearMonth,
} from "./types.js";

/** How many days of `alertsSentOn` the ledger keeps (today included). */
const ALERT_DAYS_KEPT = 7;

/** The highest stale rung the data's age reached, or null while it is fresh (or never fetched). */
export function staleRung(ageHours: number | null): number | null {
  if (ageHours === null) return null;
  const reached = STALE_RUNGS_HOURS.filter((hours) => ageHours >= hours).length;
  return reached === 0 ? null : reached - 1;
}

/** The highest permission rung reached by the days left, or null while none is ending. */
export function consentRung(ending: { readonly days: number } | null): number | null {
  if (ending === null) return null;
  const reached = CONSENT_RUNGS_DAYS.filter((days) => ending.days <= days).length;
  return reached === 0 ? null : reached - 1;
}

/** A warning ladder step: send on a higher rung than last time, follow the rung down, reset when clear. */
function ladder(
  rung: number | null,
  last: number | null,
  enabled: boolean,
): { readonly send: boolean; readonly rung: number | null } {
  if (rung === null) return { send: false, rung: null };
  const previous = last ?? -1;
  if (rung > previous) return enabled ? { send: true, rung } : { send: false, rung: last };
  return { send: false, rung };
}

/** `alertsSentOn` with one more alert notification today, trimmed to the last `ALERT_DAYS_KEPT` days. */
function countAlert(
  sentOn: Readonly<Record<string, number>>,
  today: IsoDate,
): Readonly<Record<string, number>> {
  const oldest = addDays(today, -(ALERT_DAYS_KEPT - 1));
  const kept: Record<string, number> = {};
  for (const [day, count] of Object.entries(sentOn))
    if (day >= oldest && day <= today) kept[day] = count;
  kept[today] = (kept[today] ?? 0) + 1;
  return kept;
}

/**
 * What the month-closed digest of `month` does on a plan at `now`: "schedule" while its time (the 1st at
 * 09:00) is ahead; "now" once it passed, not yet sent and still within the first `MONTH_CLOSED_DAYS` days
 * of the following month; "silent" after that window (recorded as sent, nothing told); "done" once sent.
 * The planner reads the closed month only for "schedule" and "now".
 */
export function monthClosedStep(
  month: YearMonth,
  at: { readonly today: IsoDate; readonly now: string; readonly timeZone: string },
  sentFor: string | null,
): "schedule" | "now" | "silent" | "done" {
  if (isAhead(monthClosedFireAt(month, at.timeZone), at.now)) return "schedule";
  if (sentFor === month) return "done";
  return at.today < addDays(monthClosedDay(month), MONTH_CLOSED_DAYS) ? "now" : "silent";
}

/**
 * The told-alerts ledger after this plan: every signal seen today added, entries of open signals kept,
 * closed ones forgotten after `NOTIFIED_ALERTS_DAYS`, and at most `NOTIFIED_ALERTS_MAX` (newest first).
 */
function noteAlerts(
  told: Readonly<Record<string, string>>,
  open: readonly OpenAlertSignal[],
  today: IsoDate,
): Readonly<Record<string, string>> {
  const openIds = new Set(open.map((s) => s.signal));
  const oldest = addDays(today, -(NOTIFIED_ALERTS_DAYS - 1));
  const entries = new Map(Object.entries(told));
  for (const id of openIds) if (!entries.has(id)) entries.set(id, today);
  const kept = [...entries]
    .filter(([id, day]) => openIds.has(id) || day >= oldest)
    .sort(
      ([a, dayA], [b, dayB]) =>
        Number(openIds.has(b)) - Number(openIds.has(a)) ||
        (dayA < dayB ? 1 : dayA > dayB ? -1 : a < b ? -1 : a > b ? 1 : 0),
    )
    .slice(0, NOTIFIED_ALERTS_MAX);
  return Object.fromEntries(kept.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * The notifications one plan run sends or schedules for one vault, and the ledger after it. A digest
 * whose period is already in the ledger comes again (same id) while its time is still ahead, so the
 * plan is the vault's whole pending set; once its time has passed it is never sent again.
 */
export function composeNotifications(
  input: NotificationInput,
  prefs: NotificationPrefs,
  ledger: NotificationLedger,
): NotificationPlan {
  const owner = input.role === "owner";
  const now: PlannedNotification[] = [];
  const scheduled: PlannedNotification[] = [];
  let next: NotificationLedger = { ...ledger, lastPlannedAt: input.now };

  // A "now" notification's id is `<vault>.<kind>.now` on purpose: a second one of the same kind replaces
  // the first in Notification Center (the second "alerts you follow fired" stands for both), so the
  // grouped view shows one line per kind rather than a pile.
  const planned = (message: NotificationMessage, fireAt: string | null): PlannedNotification => ({
    id: `${input.vault}.${message.kind}.${fireAt === null ? "now" : localDate(fireAt, input.timeZone)}`,
    vault: input.vault,
    profileLabel: input.profileLabel,
    message,
    fireAt,
    thread: message.kind,
  });

  /** A digest of one period: scheduled while its time is ahead, else now unless already sent. */
  const digest = (
    message: NotificationMessage,
    fireAt: string,
    period: string,
    sentFor: string | null,
  ) => {
    if (isAhead(fireAt, input.now)) {
      scheduled.push(planned(message, fireAt));
      return true;
    }
    if (sentFor === period) return false;
    now.push(planned(message, null));
    return true;
  };

  // When the phone next syncs: the marked alerts that fired and were not told yet (grouped, capped per
  // day) and device changes. Every open signal is considered once: told, or recorded without a push. A
  // signal synced late (it opened on the Mac before this phone's last plan) still counts as new here. On a
  // fresh install only the last `FRESH_INSTALL_ALERT_HOURS` are told. Alerts over the daily cap are
  // recorded as told too (dropped, as `lastPlannedAt` still advances): the cap means a few a day, never
  // a backlog the next morning.
  const untold = input.alerts.filter((s) => ledger.notifiedAlerts[s.signal] === undefined);
  const lookBack = Date.parse(input.now) - FRESH_INSTALL_ALERT_HOURS * 3_600_000;
  const tell = untold.filter(
    (s) => s.marked && (ledger.lastPlannedAt !== null || Date.parse(s.firstSeenAt) > lookBack),
  );
  if (owner && prefs.alertsFired && tell.length > 0) {
    const sentToday = ledger.alertsSentOn[input.today] ?? 0;
    if (sentToday < ALERTS_PER_DAY) {
      now.push(planned({ kind: "alerts_fired", count: tell.length }, null));
      next = { ...next, alertsSentOn: countAlert(ledger.alertsSentOn, input.today) };
    }
  }
  next = { ...next, notifiedAlerts: noteAlerts(ledger.notifiedAlerts, input.alerts, input.today) };
  if (input.devices.joined + input.devices.left > 0) {
    const { joined, left } = input.devices;
    now.push(planned({ kind: "device_change", joined, left }, null));
  }

  // Warnings, once (owner only: a partner sees them as a calm line in the app).
  if (owner) {
    const age = input.freshness.bankDataAgeHours;
    const stale = ladder(staleRung(age), ledger.staleRung, prefs.staleData);
    if (stale.send && age !== null)
      now.push(planned({ kind: "stale_data", ageHours: Math.floor(age) }, null));
    const ending = input.freshness.consentEndsInDays;
    const consent = ladder(consentRung(ending), ledger.consentRung, prefs.consentEnding);
    if (consent.send && ending !== null)
      now.push(planned({ kind: "consent_ending", days: ending.days }, null));
    next = { ...next, staleRung: stale.rung, consentRung: consent.rung };
  }

  // Month closed: the 1st of the following month in the morning, or at once within its first week;
  // after that week it is recorded as sent without telling (`monthClosedStep`). The plan line is the
  // owner's: a partner reads what was kept only.
  const closed = input.monthClosed;
  if (prefs.monthClosed && closed?.complete && isYearMonth(closed.month)) {
    const step = monthClosedStep(closed.month, input, ledger.monthClosedSentFor);
    const hasPlan = owner && input.modules.includes("investments");
    const message = { kind: "month_closed", month: closed.month, hasPlan } as const;
    if (step === "silent") next = { ...next, monthClosedSentFor: closed.month };
    else if (
      step !== "done" &&
      digest(
        message,
        monthClosedFireAt(closed.month, input.timeZone),
        closed.month,
        ledger.monthClosedSentFor,
      )
    )
      next = { ...next, monthClosedSentFor: closed.month };
  }

  // Weekly: next Sunday evening (today when it is Sunday and the time is still ahead). Never skipped.
  if (prefs.weekly) {
    const sunday = addDays(input.today, weeklyDigestOffset(input.today, input.now, input.timeZone));
    const fireAt = localFireAt(sunday, WEEKLY_HOUR, 0, input.timeZone);
    const message = {
      kind: "weekly",
      billsNextWeek: input.bills.nextWeek,
      reviewDue: owner && input.modules.includes("investments") && input.reviewDue,
      waitingOnMac: owner ? input.waitingOnMac : 0,
    } as const;
    if (digest(message, fireAt, sunday, ledger.weeklySentFor))
      next = { ...next, weeklySentFor: sunday };
  }

  // Evening: today at 19:00 while that is still ahead, else tomorrow; skipped when there is nothing to
  // say. `bills.dueTomorrow` counts the day after the digest's own day (`eveningDigestOffset`).
  if (prefs.evening && input.bills.dueTomorrow + input.toCategorize > 0) {
    const day = addDays(input.today, eveningDigestOffset(input.today, input.now, input.timeZone));
    const fireAt = localFireAt(day, EVENING_HOUR, 0, input.timeZone);
    const message = {
      kind: "evening",
      billsTomorrow: input.bills.dueTomorrow,
      toCategorize: input.toCategorize,
    } as const;
    if (digest(message, fireAt, day, ledger.eveningSentFor))
      next = { ...next, eveningSentFor: day };
  }

  scheduled.sort((a, b) =>
    (a.fireAt ?? "") < (b.fireAt ?? "") ? -1 : a.fireAt === b.fireAt ? 0 : 1,
  );
  return { notifications: [...now, ...scheduled], ledger: next };
}
