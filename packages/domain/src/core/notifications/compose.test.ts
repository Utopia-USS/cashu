// The phone's notification rules, one named test per rule, plus the design's one hard rule: a message
// carries counts and enum values only, never an amount, a payee or a name. Synthetic data only.

import { describe, expect, it } from "vitest";
import { composeNotifications } from "./compose.js";
import { ALERTS_PER_DAY, NOTIFIED_ALERTS_MAX } from "./thresholds.js";
import {
  DEFAULT_NOTIFICATION_PREFS,
  EMPTY_NOTIFICATION_LEDGER,
  type NotificationInput,
  type NotificationKind,
  type NotificationLedger,
  type NotificationMessage,
  type NotificationPrefs,
  type OpenAlertSignal,
  type YearMonth,
} from "./types.js";

// Compile-time: every property of every message arm is a number, a boolean, a "YYYY-MM" or the kind.
type SafeValue = number | boolean | YearMonth | NotificationKind;
type CountsOnly<M> = {
  [K in keyof M]-?: M[K] extends SafeValue ? true : false;
}[keyof M] extends true
  ? true
  : false;
type EveryArm<U> = U extends unknown ? CountsOnly<U> : never;
type Assert<T extends true> = T;
export type MessagesAreCountsOnly = Assert<EveryArm<NotificationMessage>>;

const VAULT = "5f0c3a9e81d24b7690ae13c7d2f4b856";
const SIGNAL_A = "01JD0000000000000000000001";
const SIGNAL_B = "01JD0000000000000000000002";
const SIGNAL_C = "01JD0000000000000000000003";

/** An open alert signal that opened `hoursAgo` before 12 November 2026, 09:00Z. */
const signal = (id: string, marked: boolean, hoursAgo = 1): OpenAlertSignal => ({
  signal: id,
  firstSeenAt: new Date(
    Date.parse("2026-11-12T09:00:00.000Z") - hoursAgo * 3_600_000,
  ).toISOString(),
  marked,
});
const ALL_MODULES = ["budget", "assets", "loans", "investments"] as const;

/** Thursday 12 November 2026, 10:00 in Warsaw. */
const owner = (over: Partial<NotificationInput> = {}): NotificationInput => ({
  vault: VAULT,
  role: "owner",
  profileLabel: "Anna",
  modules: ALL_MODULES,
  now: "2026-11-12T09:00:00.000Z",
  today: "2026-11-12",
  timeZone: "Europe/Warsaw",
  alerts: [signal(SIGNAL_A, true), signal(SIGNAL_B, true), signal(SIGNAL_C, false)],
  devices: { joined: 1, left: 0 },
  bills: { dueTomorrow: 1, nextWeek: 3 },
  toCategorize: 4,
  reviewDue: true,
  waitingOnMac: 2,
  monthClosed: { month: "2026-10", complete: true },
  freshness: { bankDataAgeHours: 40.5, consentEndsInDays: { days: 7 } },
  ...over,
});

const partner = (over: Partial<NotificationInput> = {}): NotificationInput =>
  owner({ role: "partner", profileLabel: "Home", modules: ["budget", "assets", "loans"], ...over });

const quiet = (over: Partial<NotificationInput> = {}): NotificationInput =>
  owner({
    profileLabel: null,
    alerts: [],
    devices: { joined: 0, left: 0 },
    bills: { dueTomorrow: 0, nextWeek: 0 },
    toCategorize: 0,
    reviewDue: false,
    waitingOnMac: 0,
    monthClosed: null,
    freshness: { bankDataAgeHours: 5, consentEndsInDays: null },
    ...over,
  });

const ALL_ON: NotificationPrefs = {
  ...DEFAULT_NOTIFICATION_PREFS,
  alertsFired: true,
  evening: true,
};

const prefs = (over: Partial<NotificationPrefs> = {}): NotificationPrefs => ({
  ...DEFAULT_NOTIFICATION_PREFS,
  ...over,
  deviceChanges: true,
});

const ledger = (over: Partial<NotificationLedger> = {}): NotificationLedger => ({
  ...EMPTY_NOTIFICATION_LEDGER,
  ...over,
});

/** Every signal of `owner()` recorded on its plan day. */
const TOLD_TODAY = {
  [SIGNAL_A]: "2026-11-12",
  [SIGNAL_B]: "2026-11-12",
  [SIGNAL_C]: "2026-11-12",
};

const kinds = (input: NotificationInput, p = ALL_ON, l = EMPTY_NOTIFICATION_LEDGER) =>
  composeNotifications(input, p, l).notifications.map((n) => n.message.kind);

const only = (input: NotificationInput, kind: NotificationKind, p = ALL_ON, l = ledger()) =>
  composeNotifications(input, p, l).notifications.filter((n) => n.message.kind === kind);

describe("composeNotifications: fixtures", () => {
  // The 12th is past October's first week: its digest is recorded as sent without telling.
  it("owner with everything: now-notifications first, then the digests by fire time", () => {
    const plan = composeNotifications(owner(), ALL_ON, EMPTY_NOTIFICATION_LEDGER);
    expect(plan.notifications).toEqual([
      {
        id: `${VAULT}.alerts_fired.now`,
        vault: VAULT,
        profileLabel: "Anna",
        message: { kind: "alerts_fired", count: 2 },
        fireAt: null,
        thread: "alerts_fired",
      },
      {
        id: `${VAULT}.device_change.now`,
        vault: VAULT,
        profileLabel: "Anna",
        message: { kind: "device_change", joined: 1, left: 0 },
        fireAt: null,
        thread: "device_change",
      },
      {
        id: `${VAULT}.stale_data.now`,
        vault: VAULT,
        profileLabel: "Anna",
        message: { kind: "stale_data", ageHours: 40 },
        fireAt: null,
        thread: "stale_data",
      },
      {
        id: `${VAULT}.consent_ending.now`,
        vault: VAULT,
        profileLabel: "Anna",
        message: { kind: "consent_ending", days: 7 },
        fireAt: null,
        thread: "consent_ending",
      },
      {
        id: `${VAULT}.evening.2026-11-12`,
        vault: VAULT,
        profileLabel: "Anna",
        message: { kind: "evening", billsTomorrow: 1, toCategorize: 4 },
        fireAt: "2026-11-12T18:00:00.000Z",
        thread: "evening",
      },
      {
        id: `${VAULT}.weekly.2026-11-15`,
        vault: VAULT,
        profileLabel: "Anna",
        message: { kind: "weekly", billsNextWeek: 3, reviewDue: true, waitingOnMac: 2 },
        fireAt: "2026-11-15T17:00:00.000Z",
        thread: "weekly",
      },
    ]);
    expect(plan.ledger).toEqual({
      lastPlannedAt: "2026-11-12T09:00:00.000Z",
      alertsSentOn: { "2026-11-12": 1 },
      notifiedAlerts: TOLD_TODAY,
      staleRung: 0,
      consentRung: 0,
      monthClosedSentFor: "2026-10",
      weeklySentFor: "2026-11-15",
      eveningSentFor: "2026-11-12",
    });
  });

  it("partner: the digests and device changes only", () => {
    const plan = composeNotifications(partner(), ALL_ON, EMPTY_NOTIFICATION_LEDGER);
    expect(plan.notifications.map((n) => [n.id, n.message])).toEqual([
      [`${VAULT}.device_change.now`, { kind: "device_change", joined: 1, left: 0 }],
      [`${VAULT}.evening.2026-11-12`, { kind: "evening", billsTomorrow: 1, toCategorize: 4 }],
      [
        `${VAULT}.weekly.2026-11-15`,
        { kind: "weekly", billsNextWeek: 3, reviewDue: false, waitingOnMac: 0 },
      ],
    ]);
    expect(plan.notifications.every((n) => n.profileLabel === "Home")).toBe(true);
    expect(plan.ledger).toEqual({
      ...EMPTY_NOTIFICATION_LEDGER,
      lastPlannedAt: "2026-11-12T09:00:00.000Z",
      notifiedAlerts: TOLD_TODAY,
      monthClosedSentFor: "2026-10",
      weeklySentFor: "2026-11-15",
      eveningSentFor: "2026-11-12",
    });
  });

  it("quiet day: only the weekly digest", () => {
    const plan = composeNotifications(
      quiet(),
      DEFAULT_NOTIFICATION_PREFS,
      EMPTY_NOTIFICATION_LEDGER,
    );
    expect(plan.notifications).toEqual([
      {
        id: `${VAULT}.weekly.2026-11-15`,
        vault: VAULT,
        profileLabel: null,
        message: { kind: "weekly", billsNextWeek: 0, reviewDue: false, waitingOnMac: 0 },
        fireAt: "2026-11-15T17:00:00.000Z",
        thread: "weekly",
      },
    ]);
  });

  it("is deterministic: the same inputs give the same ids, messages and ledger", () => {
    for (const input of [owner(), partner(), quiet()]) {
      expect(composeNotifications(input, ALL_ON, ledger())).toEqual(
        composeNotifications(input, ALL_ON, ledger()),
      );
    }
  });
});

describe("composeNotifications: counts only", () => {
  it("never carries an amount, a name, a gid or the profile label in a message", () => {
    for (const input of [owner(), partner(), quiet()]) {
      const plan = composeNotifications(input, ALL_ON, EMPTY_NOTIFICATION_LEDGER);
      const text = JSON.stringify(plan.notifications.map((n) => n.message));
      expect(text).not.toMatch(/\d\.\d{2}(?!\d)/u);
      for (const secret of [SIGNAL_A, SIGNAL_B, "Anna", "Home", VAULT, input.timeZone])
        expect(text).not.toContain(secret);
    }
  });
});

describe("composeNotifications: role", () => {
  it("never sends a partner alerts or warnings, whatever the prefs say", () => {
    const sent = kinds(
      partner({ freshness: { bankDataAgeHours: 200, consentEndsInDays: { days: 1 } } }),
    );
    expect(sent).not.toContain("alerts_fired");
    expect(sent).not.toContain("stale_data");
    expect(sent).not.toContain("consent_ending");
  });
});

describe("composeNotifications: alerts_fired", () => {
  /** A ledger of an earlier plan (not a fresh install). */
  const planned = (over: Partial<NotificationLedger> = {}) =>
    ledger({ lastPlannedAt: "2026-11-12T06:00:00.000Z", ...over });

  it("is off by default, and records what it saw so turning it on later tells nothing old", () => {
    const off = composeNotifications(owner(), DEFAULT_NOTIFICATION_PREFS, planned());
    expect(off.notifications.map((n) => n.message.kind)).not.toContain("alerts_fired");
    expect(off.ledger.notifiedAlerts).toEqual(TOLD_TODAY);
    expect(only(owner(), "alerts_fired", ALL_ON, off.ledger)).toEqual([]);
  });

  it("groups every marked alert not told yet into one notification per run", () => {
    expect(only(owner(), "alerts_fired", ALL_ON, planned()).map((n) => n.message)).toEqual([
      { kind: "alerts_fired", count: 2 },
    ]);
  });

  it("never pushes alerts nobody marked", () => {
    const input = owner({ alerts: [signal(SIGNAL_A, false), signal(SIGNAL_B, false)] });
    expect(only(input, "alerts_fired", ALL_ON, planned())).toEqual([]);
  });

  it("tells a signal once: the next plan skips it, a new signal is told", () => {
    const first = composeNotifications(owner(), ALL_ON, planned());
    expect(only(owner(), "alerts_fired", ALL_ON, first.ledger)).toEqual([]);
    const later = owner({
      now: "2026-11-12T12:00:00.000Z",
      alerts: [...owner().alerts, signal("01JD0000000000000000000004", true)],
    });
    expect(only(later, "alerts_fired", ALL_ON, first.ledger).map((n) => n.message)).toEqual([
      { kind: "alerts_fired", count: 1 },
    ]);
  });

  it("tells a signal synced after the last plan even when it opened before it", () => {
    // Opened on the Mac 30 hours ago, reaches the phone only now; the last plan ran 3 hours ago.
    const late = owner({ alerts: [signal(SIGNAL_A, true, 30)] });
    expect(only(late, "alerts_fired", ALL_ON, planned()).map((n) => n.message)).toEqual([
      { kind: "alerts_fired", count: 1 },
    ]);
  });

  it("on a fresh install tells only the last 24 hours and records the older ones", () => {
    const input = owner({ alerts: [signal(SIGNAL_A, true, 2), signal(SIGNAL_B, true, 30)] });
    const fresh = composeNotifications(input, ALL_ON, ledger());
    expect(fresh.notifications.find((n) => n.message.kind === "alerts_fired")?.message).toEqual({
      kind: "alerts_fired",
      count: 1,
    });
    expect(fresh.ledger.notifiedAlerts).toEqual({
      [SIGNAL_A]: "2026-11-12",
      [SIGNAL_B]: "2026-11-12",
    });
    expect(only(input, "alerts_fired", ALL_ON, fresh.ledger)).toEqual([]);
  });

  it("never pushes an alert marked after its firing was seen", () => {
    const seen = composeNotifications(
      owner({ alerts: [signal(SIGNAL_A, false)] }),
      ALL_ON,
      planned(),
    );
    const marked = owner({ alerts: [signal(SIGNAL_A, true)] });
    expect(only(marked, "alerts_fired", ALL_ON, seen.ledger)).toEqual([]);
  });

  it(`stops at ${ALERTS_PER_DAY} a day: the count stays and the capped alerts are dropped`, () => {
    const full = planned({ alertsSentOn: { "2026-11-12": ALERTS_PER_DAY } });
    const plan = composeNotifications(owner(), ALL_ON, full);
    expect(plan.notifications.map((n) => n.message.kind)).not.toContain("alerts_fired");
    expect(plan.ledger.alertsSentOn).toEqual({ "2026-11-12": ALERTS_PER_DAY });
    expect(plan.ledger.notifiedAlerts).toEqual(TOLD_TODAY);
    // A new day starts a new count (for signals not seen yet).
    const tomorrow = owner({ today: "2026-11-13", now: "2026-11-13T09:00:00.000Z" });
    expect(only(tomorrow, "alerts_fired", ALL_ON, full)).toHaveLength(1);
    expect(only(tomorrow, "alerts_fired", ALL_ON, plan.ledger)).toEqual([]);
  });

  it("counts the day's alert notifications and keeps a week of days", () => {
    const old = planned({
      alertsSentOn: { "2026-11-01": 3, "2026-11-06": 2, "2026-11-12": 1 },
    });
    expect(composeNotifications(owner(), ALL_ON, old).ledger.alertsSentOn).toEqual({
      "2026-11-06": 2,
      "2026-11-12": 2,
    });
  });

  it("forgets closed signals after 30 days, never an open one, and keeps at most 200", () => {
    const told = planned({
      notifiedAlerts: {
        [SIGNAL_A]: "2026-09-01",
        "01JD0000000000000000000010": "2026-10-14",
        "01JD0000000000000000000011": "2026-10-13",
      },
    });
    const input = owner({ alerts: [signal(SIGNAL_A, true)] });
    expect(composeNotifications(input, ALL_ON, told).ledger.notifiedAlerts).toEqual({
      [SIGNAL_A]: "2026-09-01",
      "01JD0000000000000000000010": "2026-10-14",
    });
    const many = Object.fromEntries(
      Array.from({ length: NOTIFIED_ALERTS_MAX + 20 }, (_, i) => [
        `01JE${String(i).padStart(22, "0")}`,
        "2026-11-10",
      ]),
    );
    const capped = composeNotifications(input, ALL_ON, planned({ notifiedAlerts: many }));
    expect(Object.keys(capped.ledger.notifiedAlerts)).toHaveLength(NOTIFIED_ALERTS_MAX);
    expect(capped.ledger.notifiedAlerts[SIGNAL_A]).toBe("2026-11-12");
  });
});

describe("composeNotifications: device_change", () => {
  it("sends one notification now when a device joined or left, for the partner too", () => {
    const input = partner({ devices: { joined: 1, left: 2 } });
    expect(only(input, "device_change", DEFAULT_NOTIFICATION_PREFS)).toEqual([
      expect.objectContaining({
        fireAt: null,
        message: { kind: "device_change", joined: 1, left: 2 },
      }),
    ]);
  });

  it("stays quiet without a change", () => {
    expect(only(owner({ devices: { joined: 0, left: 0 } }), "device_change")).toEqual([]);
  });
});

describe("composeNotifications: evening", () => {
  it("is off by default", () => {
    expect(only(owner(), "evening", DEFAULT_NOTIFICATION_PREFS)).toEqual([]);
  });

  it("fires at 19:00 today while that is ahead", () => {
    expect(only(owner(), "evening").map((n) => n.fireAt)).toEqual(["2026-11-12T18:00:00.000Z"]);
  });

  it("moves to tomorrow after 19:00 and within the last minute before it", () => {
    for (const now of ["2026-11-12T18:30:00.000Z", "2026-11-12T17:59:30.000Z"]) {
      const [evening] = only(owner({ now }), "evening");
      expect(evening?.fireAt).toBe("2026-11-13T18:00:00.000Z");
      expect(evening?.id).toBe(`${VAULT}.evening.2026-11-13`);
    }
  });

  it("is skipped when there is nothing to say", () => {
    const input = owner({ bills: { dueTomorrow: 0, nextWeek: 3 }, toCategorize: 0 });
    const plan = composeNotifications(input, ALL_ON, ledger());
    expect(plan.notifications.map((n) => n.message.kind)).not.toContain("evening");
    expect(plan.ledger.eveningSentFor).toBeNull();
  });

  it("comes again with the same id when the planner re-runs before it fires", () => {
    const first = composeNotifications(owner(), ALL_ON, ledger());
    const again = composeNotifications(
      owner({ now: "2026-11-12T15:00:00.000Z", toCategorize: 6 }),
      ALL_ON,
      first.ledger,
    );
    const evening = again.notifications.find((n) => n.message.kind === "evening");
    expect(evening?.id).toBe(`${VAULT}.evening.2026-11-12`);
    expect(evening?.message).toEqual({ kind: "evening", billsTomorrow: 1, toCategorize: 6 });
  });
});

describe("composeNotifications: weekly", () => {
  it("fires next Sunday at 18:00", () => {
    expect(only(owner(), "weekly").map((n) => n.fireAt)).toEqual(["2026-11-15T17:00:00.000Z"]);
  });

  it("fires today on a Sunday before 18:00, next Sunday after it", () => {
    const sunday = { today: "2026-11-15" };
    expect(
      only(owner({ ...sunday, now: "2026-11-15T12:00:00.000Z" }), "weekly").map((n) => n.fireAt),
    ).toEqual(["2026-11-15T17:00:00.000Z"]);
    expect(
      only(owner({ ...sunday, now: "2026-11-15T17:30:00.000Z" }), "weekly").map((n) => n.fireAt),
    ).toEqual(["2026-11-22T17:00:00.000Z"]);
  });

  it("says review due only to an owner with investments", () => {
    const message = (input: NotificationInput) => only(input, "weekly")[0]?.message;
    expect(message(owner())).toMatchObject({ reviewDue: true, waitingOnMac: 2 });
    expect(message(owner({ modules: ["budget"] }))).toMatchObject({ reviewDue: false });
    expect(message(partner({ modules: ALL_MODULES }))).toMatchObject({
      reviewDue: false,
      waitingOnMac: 0,
    });
  });

  it("is never skipped, even with nothing to count", () => {
    expect(kinds(quiet(), DEFAULT_NOTIFICATION_PREFS)).toEqual(["weekly"]);
  });

  it("can be turned off", () => {
    expect(kinds(quiet(), prefs({ weekly: false }))).toEqual([]);
  });
});

describe("composeNotifications: month_closed", () => {
  const closing = { month: "2026-10", complete: true };
  const onDay = (day: string) =>
    owner({ today: `2026-11-${day}`, now: `2026-11-${day}T10:00:00.000Z`, monthClosed: closing });

  it("waits for the 1st at 09:00 while that is ahead", () => {
    const input = owner({ today: "2026-10-31", now: "2026-10-31T12:00:00.000Z" });
    const plan = composeNotifications({ ...input, monthClosed: closing }, ALL_ON, ledger());
    const closed = plan.notifications.find((n) => n.message.kind === "month_closed");
    expect(closed?.fireAt).toBe("2026-11-01T08:00:00.000Z");
    expect(closed?.id).toBe(`${VAULT}.month_closed.2026-11-01`);
    expect(plan.ledger.monthClosedSentFor).toBe("2026-10");
  });

  it("goes now when the planner runs after the 1st, and only once", () => {
    const first = composeNotifications(onDay("03"), ALL_ON, ledger());
    expect(only(onDay("03"), "month_closed").map((n) => n.fireAt)).toEqual([null]);
    expect(only(onDay("04"), "month_closed", ALL_ON, first.ledger)).toEqual([]);
  });

  it("waits for a complete month, and the toggle", () => {
    const open = onDay("03");
    expect(only({ ...open, monthClosed: { ...closing, complete: false } }, "month_closed")).toEqual(
      [],
    );
    expect(only({ ...open, monthClosed: null }, "month_closed")).toEqual([]);
    expect(only(open, "month_closed", prefs({ monthClosed: false }))).toEqual([]);
  });

  it("ignores a month that is not YYYY-MM", () => {
    expect(
      only({ ...onDay("03"), monthClosed: { ...closing, month: "October" } }, "month_closed"),
    ).toEqual([]);
  });

  it("mentions the plan only to an owner with the investments module", () => {
    expect(only(onDay("03"), "month_closed")[0]?.message).toMatchObject({ hasPlan: true });
    const budgetOnly = { ...onDay("03"), modules: ["budget"] };
    expect(only(budgetOnly, "month_closed")[0]?.message).toMatchObject({ hasPlan: false });
    const follower = { ...onDay("03"), role: "partner" as const };
    expect(only(follower, "month_closed")[0]?.message).toMatchObject({ hasPlan: false });
  });

  it("goes at once up to the 7th of the following month", () => {
    const plan = composeNotifications(onDay("07"), ALL_ON, ledger());
    expect(plan.notifications.find((n) => n.message.kind === "month_closed")?.fireAt).toBeNull();
    expect(plan.ledger.monthClosedSentFor).toBe("2026-10");
  });

  it("from the 8th on is recorded as sent without telling", () => {
    const plan = composeNotifications(onDay("08"), ALL_ON, ledger());
    expect(plan.notifications.map((n) => n.message.kind)).not.toContain("month_closed");
    expect(plan.ledger.monthClosedSentFor).toBe("2026-10");
  });
});

describe("composeNotifications: stale_data", () => {
  const aged = (hours: number | null) =>
    owner({ freshness: { bankDataAgeHours: hours, consentEndsInDays: null } });

  it("warns once at 36 hours and again only when it gets worse", () => {
    const at40 = composeNotifications(aged(40), ALL_ON, ledger());
    expect(at40.ledger.staleRung).toBe(0);
    expect(only(aged(60), "stale_data", ALL_ON, at40.ledger)).toEqual([]);
    const at80 = composeNotifications(aged(80), ALL_ON, at40.ledger);
    expect(at80.notifications.find((n) => n.message.kind === "stale_data")?.message).toEqual({
      kind: "stale_data",
      ageHours: 80,
    });
    expect(at80.ledger.staleRung).toBe(1);
    expect(composeNotifications(aged(170), ALL_ON, at80.ledger).ledger.staleRung).toBe(2);
  });

  it("stays quiet under 36 hours and resets once the data is fresh again", () => {
    expect(only(aged(35.9), "stale_data")).toEqual([]);
    const fresh = composeNotifications(aged(2), ALL_ON, ledger({ staleRung: 2 }));
    expect(fresh.ledger.staleRung).toBeNull();
    expect(only(aged(40), "stale_data", ALL_ON, fresh.ledger)).toHaveLength(1);
    expect(
      composeNotifications(aged(null), ALL_ON, ledger({ staleRung: 1 })).ledger.staleRung,
    ).toBe(null);
  });

  it("follows a new, milder staleness down so it warns when it climbs again", () => {
    const milder = composeNotifications(aged(40), ALL_ON, ledger({ staleRung: 2 }));
    expect(milder.notifications.map((n) => n.message.kind)).not.toContain("stale_data");
    expect(milder.ledger.staleRung).toBe(0);
  });

  it("sends nothing and keeps the ledger when turned off", () => {
    const off = composeNotifications(aged(80), prefs({ staleData: false }), ledger());
    expect(off.notifications.map((n) => n.message.kind)).not.toContain("stale_data");
    expect(off.ledger.staleRung).toBeNull();
  });
});

describe("composeNotifications: consent_ending", () => {
  const ending = (days: number | null) =>
    owner({
      freshness: { bankDataAgeHours: 1, consentEndsInDays: days === null ? null : { days } },
    });

  it("warns 7 days and 1 day before, once each", () => {
    expect(only(ending(9), "consent_ending")).toEqual([]);
    const week = composeNotifications(ending(7), ALL_ON, ledger());
    expect(week.ledger.consentRung).toBe(0);
    expect(only(ending(4), "consent_ending", ALL_ON, week.ledger)).toEqual([]);
    const day = composeNotifications(ending(1), ALL_ON, week.ledger);
    expect(day.notifications.find((n) => n.message.kind === "consent_ending")?.message).toEqual({
      kind: "consent_ending",
      days: 1,
    });
    expect(only(ending(0), "consent_ending", ALL_ON, day.ledger)).toEqual([]);
  });

  it("resets when no permission is ending", () => {
    expect(
      composeNotifications(ending(null), ALL_ON, ledger({ consentRung: 1 })).ledger,
    ).toMatchObject({ consentRung: null });
  });

  it("sends nothing when turned off", () => {
    expect(only(ending(1), "consent_ending", prefs({ consentEnding: false }))).toEqual([]);
  });
});
