// The notification planner: for every vault on this phone, count what the composer needs (bills,
// payments to categorize, the review, what waits on the Mac, the closed month, the bank data's age and
// the marked alerts that fired), compose the vault's notifications with the user's choices and the
// sent-ledger, render their text on this phone, and bring the OS's pending list in line with the plan.
// Works outside React (the shell's hook and the background task call it the same way through `runPlan`).
// Reads only what the vault's choices can use (a switched-off digest costs nothing); the one write is
// each vault's ledger, after its notifications were scheduled.
import type { IsoDate } from "@cashu/domain";
import {
  composeNotifications,
  DEFAULT_NOTIFICATION_PREFS,
  EMPTY_NOTIFICATION_LEDGER,
  eveningDigestOffset,
  isYearMonth,
  monthClosedStep,
  NEXT_WEEK_DAYS,
  type NotificationInput,
  type NotificationLedger,
  type NotificationMessage,
  type NotificationPrefs,
  type OpenAlertSignal,
  type PlannedNotification,
  type ProfileRole,
  weeklyDigestOffset,
} from "@cashu/domain/core/notifications";
import type { Lang } from "@cashu/i18n";
import { budgetUncategorizedCount } from "@cashu/store/budget/companion";
import { dataFreshness } from "@cashu/store/budget/freshness";
import { pendingProposalsCount, profileIdentity } from "@cashu/store/core/profile";
import {
  markedAlerts,
  notificationLedger,
  notificationPrefs,
  setNotificationLedger,
} from "@cashu/store/device";
import { readSignalRows } from "@cashu/store/investments/signals-screen";
import type { Read } from "@cashu/store/query";
import { shiftMonth } from "../format/calendar";
import type { Services } from "../services/services";
import { monthClosedState } from "./monthClosedRules";
import { renderNotification } from "./render";
import {
  type NotificationScheduler,
  OUR_PREFIX,
  PREVIEW_PREFIX,
  type ScheduledNotification,
} from "./scheduler";

const HOUR_MS = 3_600_000;

/** What the planner needs of the services (the background task passes the booted ones). */
export type PlannerServices = Pick<Services, "profiles" | "storeOf" | "device" | "moneyQueries">;

export interface PlanContext {
  readonly services: PlannerServices;
  readonly scheduler: NotificationScheduler;
  readonly now: Date;
  /** The device's local day. */
  readonly today: IsoDate;
  /** IANA zone of the fire times. */
  readonly timeZone: string;
  /** The language and locale the text is written in (the app's). */
  readonly lang: Lang;
  readonly locale: string;
}

export type PlanOutcome =
  | { readonly kind: "no_permission"; readonly cancelled: number }
  | {
      readonly kind: "planned";
      /** Pending notifications scheduled or replaced. */
      readonly scheduled: number;
      /** Notifications delivered at once. */
      readonly delivered: number;
      readonly cancelled: number;
      /** Vaults whose scheduling failed (their ledger stays as it was; the next run tries again). */
      readonly failed: number;
      /** How long reading and composing each vault took, in ms (profile order; the bench line). */
      readonly msPerVault: readonly number[];
    };

type Profile = PlannerServices["profiles"][number];

/**
 * Every open alert signal still waiting for the owner (an action signal without a decision, not snoozed,
 * not research: as the tab dot counts), with whether its alert is marked "tell my phone". The composer
 * decides which ones are new (its ledger), so a signal synced late still counts.
 */
function openAlertSignals(
  read: Read,
  now: string,
  marked: readonly string[],
): readonly OpenAlertSignal[] {
  return readSignalRows(read, now, "open")
    .filter(
      (s) =>
        s.severity === "action" &&
        s.decisions.length === 0 &&
        !s.snoozed &&
        s.source !== "research",
    )
    .map((s) => ({
      signal: s.gid,
      firstSeenAt: s.firstSeenAt,
      marked: s.alert !== null && marked.includes(s.alert),
    }));
}

/** Every choice on: the dev preview reads every count whatever the user chose. */
const EVERYTHING: NotificationPrefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  weekly: true,
  monthClosed: true,
  evening: true,
};

/**
 * The counts-only input of one vault's plan. Reads only what `prefs` and the ledger can use: the bills
 * when a digest that counts them is on, the payments to categorize for the evening, the review and the
 * Mac's proposals for an owner's weekly, the closed month only while its digest can still go out, the
 * alert signals for an owner with investments. `preview` reads the closed month whatever its window.
 */
function notificationInputOf(
  ctx: Omit<PlanContext, "scheduler">,
  profile: Profile,
  ledger: NotificationLedger,
  prefs: NotificationPrefs,
  preview = false,
): NotificationInput {
  const { services, today, timeZone, lang } = ctx;
  const now = ctx.now.toISOString();
  const store = services.storeOf(profile.vault);
  const read: Read = store.read.bind(store);
  const deviceRead: Read = (sql, ...params) => services.device.read(sql, ...params);
  const { companion, investments } = services.moneyQueries;
  const owner = profile.role === "owner";
  const invests = profile.modules.includes("investments");

  // Bills: the evening digest speaks about the day after its own day (tonight's: tomorrow; after 19:00
  // the digest moves to tomorrow evening and speaks about the day after); the weekly one about the 7
  // days after its Sunday. Both offsets come from the composer's own schedule rules.
  const evening = eveningDigestOffset(today, now, timeZone);
  const sunday = weeklyDigestOffset(today, now, timeZone);
  const rows =
    prefs.evening || prefs.weekly
      ? companion.upcoming.run(read, {
          today,
          horizonDays: Math.max(evening + 1, sunday + NEXT_WEEK_DAYS),
        }).rows
      : [];
  const dueTomorrow = prefs.evening ? rows.filter((r) => r.daysUntil === evening + 1).length : 0;
  const nextWeek = prefs.weekly
    ? rows.filter((r) => r.daysUntil > sunday && r.daysUntil <= sunday + NEXT_WEEK_DAYS).length
    : 0;

  // The previous month, only while its digest can still be scheduled or sent (`monthClosedStep`): the
  // month-close read builds the whole budget book.
  const month = shiftMonth(today.slice(0, 7), -1);
  const step = isYearMonth(month)
    ? monthClosedStep(month, { today, now, timeZone }, ledger.monthClosedSentFor)
    : "done";
  const readClosed = preview || (prefs.monthClosed && (step === "schedule" || step === "now"));
  const closed = readClosed
    ? monthClosedState(companion.monthClose.run(read, { today, month, lang }), month, today)
    : null;

  const bankDataAt = owner ? dataFreshness.run(read, undefined).bankDataAt : null;
  const base = prefs.evening ? (profileIdentity.run(read, undefined)?.baseCurrency ?? null) : null;
  const weeklyOwner = prefs.weekly && owner;

  return {
    vault: profile.vault,
    role: profile.role satisfies ProfileRole,
    // "cashU · Anna" only when the phone holds two or more profiles (designer #22.2).
    profileLabel: services.profiles.length >= 2 ? profile.name : null,
    modules: profile.modules,
    now,
    today,
    timeZone,
    // Read even with the switch off: what was seen meanwhile is recorded, so turning it on tells nothing old.
    alerts:
      owner && invests
        ? openAlertSignals(read, now, markedAlerts.run(deviceRead, { vault: profile.vault }))
        : [],
    // TRANSITIONAL(S44): the phone has no device registry before pairing; the composer keeps the rule.
    devices: { joined: 0, left: 0 },
    bills: { dueTomorrow, nextWeek },
    toCategorize: prefs.evening
      ? budgetUncategorizedCount.run(read, { month: today.slice(0, 7), currency: base })
      : 0,
    reviewDue:
      weeklyOwner && invests
        ? (investments.reviewDue.run(read, { today, timeZone })?.due ?? false)
        : false,
    waitingOnMac: weeklyOwner ? pendingProposalsCount.run(read, undefined) : 0,
    monthClosed: closed === null ? null : { month, complete: closed.complete },
    freshness: {
      bankDataAgeHours:
        bankDataAt === null ? null : (ctx.now.getTime() - Date.parse(bankDataAt)) / HOUR_MS,
      // No bank permission end date is synced (it lives in the host's secrets): never warned for now.
      consentEndsInDays: null,
    },
  };
}

/**
 * Dev builds' QA aid: tonight's evening, weekly and month-closed digests of one vault with its real
 * counts, delivered `delayMs` after `ctx.now` whatever the choices or the ledger say (an empty evening
 * is still skipped), so the lock-screen text can be checked. Writes nothing.
 */
export function previewNotifications(
  ctx: Omit<PlanContext, "scheduler">,
  vault: string,
  delayMs: number,
): ScheduledNotification[] {
  const profile = ctx.services.profiles.find((p) => p.vault === vault);
  if (profile === undefined) return [];
  const input = notificationInputOf(ctx, profile, EMPTY_NOTIFICATION_LEDGER, EVERYTHING, true);
  const owner = input.role === "owner";
  const invests = input.modules.includes("investments");
  const fireAt = new Date(ctx.now.getTime() + delayMs).toISOString();
  const messages: NotificationMessage[] = [];
  // Skipped when empty, as the real evening digest (an empty body would show nothing).
  if (input.bills.dueTomorrow + input.toCategorize > 0)
    messages.push({
      kind: "evening",
      billsTomorrow: input.bills.dueTomorrow,
      toCategorize: input.toCategorize,
    });
  messages.push({
    kind: "weekly",
    billsNextWeek: input.bills.nextWeek,
    reviewDue: owner && invests && input.reviewDue,
    waitingOnMac: owner ? input.waitingOnMac : 0,
  });
  const month = input.monthClosed?.month ?? "";
  if (isYearMonth(month)) messages.push({ kind: "month_closed", month, hasPlan: owner && invests });
  return messages.map((message) => {
    const planned = toScheduled(
      { id: "", vault, profileLabel: input.profileLabel, message, fireAt, thread: message.kind },
      ctx,
    );
    return { ...planned, id: `${PREVIEW_PREFIX}${vault}.${message.kind}` };
  });
}

/** The OS form of one planned notification: our id prefix, the text written on this phone. */
function toScheduled(
  planned: PlannedNotification,
  ctx: Pick<PlanContext, "lang" | "locale" | "now">,
): ScheduledNotification {
  const { title, body } = renderNotification(
    planned.message,
    planned.profileLabel,
    ctx.lang,
    ctx.locale,
    ctx.now,
  );
  return {
    id: `${OUR_PREFIX}${planned.id}`,
    title,
    body,
    thread: planned.thread,
    data: {
      vault: planned.vault,
      kind: planned.message.kind,
      ...(planned.message.kind === "month_closed" ? { month: planned.message.month } : {}),
    },
    fireAt: planned.fireAt,
  };
}

/**
 * Plan every vault's notifications and make the OS's pending list match: cancel ours that left the
 * plan, schedule (or replace) the rest, deliver the "now" ones, and write each vault's ledger once its
 * notifications are in. Without permission it cancels ours and writes nothing.
 */
export async function planNotifications(ctx: PlanContext): Promise<PlanOutcome> {
  const { services, scheduler } = ctx;
  const existing = await scheduler.scheduled();
  if ((await scheduler.permission()) !== "granted") {
    // Previews included: nothing of ours stays pending without the permission.
    if (existing.length > 0) await scheduler.cancel(existing);
    return { kind: "no_permission", cancelled: existing.length };
  }
  const deviceRead: Read = (sql, ...params) => services.device.read(sql, ...params);
  const plans = services.profiles.map((profile) => {
    const started = performance.now();
    const ledger = notificationLedger.run(deviceRead, { vault: profile.vault });
    const prefs = notificationPrefs.run(deviceRead, { vault: profile.vault });
    const input = notificationInputOf(ctx, profile, ledger, prefs);
    const plan = composeNotifications(input, prefs, ledger);
    const ms = Math.round((performance.now() - started) * 10) / 10;
    return {
      vault: profile.vault,
      plan,
      ms,
      out: plan.notifications.map((n) => toScheduled(n, ctx)),
    };
  });
  const wanted = new Set(
    plans.flatMap((p) => p.out.filter((n) => n.fireAt !== null).map((n) => n.id)),
  );
  // Previews are left alone: a re-plan (the app going to the background) never cancels them.
  const stale = existing.filter((id) => id.startsWith(OUR_PREFIX) && !wanted.has(id));
  if (stale.length > 0) await scheduler.cancel(stale);

  let scheduled = 0;
  let delivered = 0;
  let failed = 0;
  for (const { vault, plan, out } of plans) {
    try {
      for (const n of out) await scheduler.schedule(n);
    } catch {
      failed++;
      continue;
    }
    scheduled += out.filter((n) => n.fireAt !== null).length;
    delivered += out.filter((n) => n.fireAt === null).length;
    services.device.run(setNotificationLedger, { vault, ledger: plan.ledger });
  }
  return {
    kind: "planned",
    scheduled,
    delivered,
    cancelled: stale.length,
    failed,
    msPerVault: plans.map((p) => p.ms),
  };
}
