// The notification planner over real synthetic stores and an in-memory scheduler: nothing without
// permission, the same ids on a re-plan, a choice turned off cancels what it scheduled, a partner gets
// digests only, a marked alert is told once, and the ledger is written after scheduling. Synthetic data.
import { EMPTY_NOTIFICATION_LEDGER } from "@cashu/domain/core/notifications";
import {
  markedAlerts,
  notificationLedger,
  setAlertMarked,
  setNotificationPrefs,
} from "@cashu/store/device";
import type { Read } from "@cashu/store/query";
import { companionMarkedAlert } from "../fixture/companionInvestments";
import { investmentsStore } from "../screens/testing/investmentsStore";
import {
  importMoneyFacts,
  MONEY_OWN_A,
  MONEY_OWN_B,
  MONEY_VAULT_A,
  MONEY_VAULT_B,
  moneyStore,
} from "../screens/testing/moneyStore";
import { type PlanContext, planNotifications, previewNotifications } from "./planner";
import { memoryScheduler } from "./testing/memoryScheduler";

const LOCAL_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

function context(
  services: PlanContext["services"],
  scheduler: PlanContext["scheduler"],
  now: Date,
  today: string,
  timeZone = LOCAL_ZONE,
): PlanContext {
  return { services, scheduler, now, today, timeZone, lang: "en", locale: "en-US" };
}

const deviceRead =
  (device: PlanContext["services"]["device"]): Read =>
  (sql, ...params) =>
    device.read(sql, ...params);

describe("planNotifications: an owner with investments", () => {
  function owner() {
    const fixture = investmentsStore();
    const now = new Date(fixture.now);
    const read: Read = (sql, ...params) => fixture.store.read(sql, ...params);
    const alert = companionMarkedAlert(read, fixture.now);
    if (alert === null) throw new Error("the synthetic portfolio fired no action alert");
    const vault = fixture.services.profiles[0]?.vault ?? "";
    return { fixture, now, alert, vault };
  }

  it("schedules nothing and writes nothing without permission", async () => {
    const { fixture, now, vault } = owner();
    const scheduler = memoryScheduler("denied");
    const outcome = await planNotifications(
      context(fixture.services, scheduler, now, fixture.today),
    );
    expect(outcome).toEqual({ kind: "no_permission", cancelled: 0 });
    expect(scheduler.pending.size).toBe(0);
    expect(scheduler.delivered).toEqual([]);
    expect(notificationLedger.run(deviceRead(fixture.device), { vault })).toEqual(
      EMPTY_NOTIFICATION_LEDGER,
    );
    fixture.close();
  });

  it("cancels its own pending notifications when the permission is gone", async () => {
    const { fixture, now } = owner();
    const scheduler = memoryScheduler("granted");
    await planNotifications(context(fixture.services, scheduler, now, fixture.today));
    const before = [...scheduler.pending.keys()];
    expect(before.length).toBeGreaterThan(0);
    scheduler.setPermission("denied");
    const outcome = await planNotifications(
      context(fixture.services, scheduler, now, fixture.today),
    );
    expect(outcome).toEqual({ kind: "no_permission", cancelled: before.length });
    expect(scheduler.pending.size).toBe(0);
    fixture.close();
  });

  it("re-plans to the same ids, and a choice turned off cancels its notification", async () => {
    const { fixture, now, vault } = owner();
    const scheduler = memoryScheduler("granted");
    await planNotifications(context(fixture.services, scheduler, now, fixture.today));
    const first = [...scheduler.pending.keys()].sort();
    expect(first).toEqual([`cashu.${vault}.weekly.2026-11-15`]);
    const weekly = scheduler.pending.get(`cashu.${vault}.weekly.2026-11-15`);
    expect(weekly?.title).toBe("cashU");
    expect(weekly?.thread).toBe("weekly");
    expect(weekly?.data).toEqual({ vault, kind: "weekly" });
    expect(weekly?.body).toMatch(/^Your week is ready\./u);

    const later = new Date(now.getTime() + 60_000);
    const again = await planNotifications(
      context(fixture.services, scheduler, later, fixture.today),
    );
    expect([...scheduler.pending.keys()].sort()).toEqual(first);
    expect(again).toMatchObject({ kind: "planned", cancelled: 0 });

    fixture.services.device.run(setNotificationPrefs, { vault, prefs: { weekly: false } });
    const off = await planNotifications(context(fixture.services, scheduler, later, fixture.today));
    expect(off).toMatchObject({ kind: "planned", scheduled: 0, cancelled: 1 });
    expect(scheduler.pending.size).toBe(0);
    expect(scheduler.cancelled).toEqual(first);
    fixture.close();
  });

  it("tells a marked alert once, grouped, and not again on the next plan", async () => {
    const { fixture, now, alert, vault } = owner();
    const { device } = fixture.services;
    device.run(setAlertMarked, { vault, alert, marked: true });
    device.run(setNotificationPrefs, { vault, prefs: { alertsFired: true } });
    expect(markedAlerts.run(deviceRead(device), { vault })).toEqual([alert]);
    const scheduler = memoryScheduler("granted");

    const first = await planNotifications(context(fixture.services, scheduler, now, fixture.today));
    expect(first).toMatchObject({ kind: "planned", delivered: 1, failed: 0 });
    expect(scheduler.delivered.map((n) => [n.id, n.thread, n.body])).toEqual([
      [
        `cashu.${vault}.alerts_fired.now`,
        "alerts_fired",
        "An alert you follow fired. Open cashU to see it.",
      ],
    ]);
    const ledger = notificationLedger.run(deviceRead(device), { vault });
    expect(ledger.lastPlannedAt).toBe(now.toISOString());
    expect(ledger.alertsSentOn).toEqual({ [fixture.today]: 1 });
    expect(ledger.weeklySentFor).toBe("2026-11-15");

    const next = await planNotifications(
      context(fixture.services, scheduler, new Date(now.getTime() + 120_000), fixture.today),
    );
    expect(next).toMatchObject({ kind: "planned", delivered: 0 });
    expect(scheduler.delivered).toHaveLength(1);
    fixture.close();
  });

  it("never tells an alert that is not marked", async () => {
    const { fixture, now, vault } = owner();
    fixture.services.device.run(setNotificationPrefs, { vault, prefs: { alertsFired: true } });
    const scheduler = memoryScheduler("granted");
    await planNotifications(context(fixture.services, scheduler, now, fixture.today));
    expect(scheduler.delivered).toEqual([]);
    fixture.close();
  });

  it("keeps the ledger when scheduling fails, so the next run tries again", async () => {
    const { fixture, now, vault } = owner();
    const scheduler = memoryScheduler("granted", { failSchedule: true });
    const outcome = await planNotifications(
      context(fixture.services, scheduler, now, fixture.today),
    );
    expect(outcome).toMatchObject({ kind: "planned", failed: 1, scheduled: 0 });
    expect(notificationLedger.run(deviceRead(fixture.device), { vault })).toEqual(
      EMPTY_NOTIFICATION_LEDGER,
    );
    fixture.close();
  });
});

describe("planNotifications: two profiles, an owner and a partner", () => {
  /** Thursday 5 November 2026, 09:00 in Warsaw; both vaults' bank data is from 31 October. */
  const NOW = new Date("2026-11-05T08:00:00Z");
  const TODAY = "2026-11-05";

  function household() {
    const fixture = moneyStore();
    for (const [handle, account] of [
      [fixture.a, MONEY_OWN_A],
      [fixture.b, MONEY_OWN_B],
    ] as const)
      importMoneyFacts(handle, "PLN", account, [
        { date: "2026-10-30", amount: "-42.00", key: "synthetic-1" },
      ]);
    return fixture;
  }

  it("warns the owner about old bank data, gives the partner digests only, names the profiles", async () => {
    const fixture = household();
    const scheduler = memoryScheduler("granted");
    await planNotifications(context(fixture.services, scheduler, NOW, TODAY, "Europe/Warsaw"));
    const kindsOf = (vault: string) =>
      [...scheduler.delivered, ...scheduler.pending.values()]
        .filter((n) => n.data.vault === vault)
        .map((n) => n.thread)
        .sort();
    // October closed with figures in it: both get its digest at once (the plan runs in its first week).
    expect(kindsOf(MONEY_VAULT_A)).toEqual(["month_closed", "stale_data", "weekly"]);
    expect(kindsOf(MONEY_VAULT_B)).toEqual(["month_closed", "weekly"]);
    const stale = scheduler.delivered.find(
      (n) => n.data.vault === MONEY_VAULT_A && n.thread === "stale_data",
    );
    expect(stale?.title).toBe("cashU · Synthetic A");
    expect(stale?.body).toMatch(/^Bank data has not been updated since /u);
    expect(scheduler.pending.get(`cashu.${MONEY_VAULT_B}.weekly.2026-11-08`)?.title).toBe(
      "cashU · Synthetic B",
    );
    const closed = scheduler.delivered.find(
      (n) => n.data.vault === MONEY_VAULT_B && n.thread === "month_closed",
    );
    expect(closed?.data).toEqual({ vault: MONEY_VAULT_B, kind: "month_closed", month: "2026-10" });
    expect(closed?.body).toBe("October closed. Open cashU to see what you kept.");

    // The partner's choices do not matter for warnings: still digests only.
    fixture.services.device.run(setNotificationPrefs, {
      vault: MONEY_VAULT_B,
      prefs: { staleData: true, consentEnding: true, alertsFired: true, evening: true },
    });
    const partner = memoryScheduler("granted");
    await planNotifications(context(fixture.services, partner, NOW, TODAY, "Europe/Warsaw"));
    expect(
      [...partner.delivered, ...partner.pending.values()]
        .filter((n) => n.data.vault === MONEY_VAULT_B)
        .every((n) => ["weekly", "evening", "month_closed"].includes(n.thread)),
    ).toBe(true);
    fixture.close();
  });

  it("sends the closed month once, not again the next day", async () => {
    const fixture = household();
    const scheduler = memoryScheduler("granted");
    const ctx = context(fixture.services, scheduler, NOW, TODAY, "Europe/Warsaw");
    await planNotifications(ctx);
    await planNotifications({ ...ctx, now: new Date("2026-11-06T08:00:00Z"), today: "2026-11-06" });
    // One per vault, from the first plan only.
    expect(scheduler.delivered.filter((n) => n.thread === "month_closed")).toHaveLength(2);
    expect(
      notificationLedger.run(deviceRead(fixture.device), { vault: MONEY_VAULT_A })
        .monthClosedSentFor,
    ).toBe("2026-10");
    fixture.close();
  });

  it.each([
    ["07", 1],
    ["08", 0],
  ] as const)("sends the closed month on a first plan on the %sth: %i", async (day, sends) => {
    const fixture = household();
    const scheduler = memoryScheduler("granted");
    const now = new Date(`2026-11-${day}T08:00:00Z`);
    await planNotifications(
      context(fixture.services, scheduler, now, `2026-11-${day}`, "Europe/Warsaw"),
    );
    const sent = scheduler.delivered.filter(
      (n) => n.thread === "month_closed" && n.data.vault === MONEY_VAULT_A,
    );
    expect(sent).toHaveLength(sends);
    fixture.close();
  });

  it("reads the closed month only while its digest can still go out, and times each vault", async () => {
    const fixture = household();
    const monthClose = jest.spyOn(fixture.services.moneyQueries.companion.monthClose, "run");
    const at = (day: string) =>
      context(
        fixture.services,
        memoryScheduler("granted"),
        new Date(`2026-11-${day}T08:00:00Z`),
        `2026-11-${day}`,
        "Europe/Warsaw",
      );
    const outcome = await planNotifications(at("05"));
    expect(monthClose).toHaveBeenCalledTimes(2);
    expect(outcome).toMatchObject({ kind: "planned" });
    expect(outcome.kind === "planned" ? outcome.msPerVault : []).toHaveLength(2);
    // Sent for both vaults: the next plans of the week read it no more; nor does anything after the 7th.
    monthClose.mockClear();
    await planNotifications(at("06"));
    await planNotifications(at("09"));
    expect(monthClose).not.toHaveBeenCalled();
    // Switched off: never read.
    const off = household();
    const offRead = jest.spyOn(off.services.moneyQueries.companion.monthClose, "run");
    for (const vault of [MONEY_VAULT_A, MONEY_VAULT_B])
      off.services.device.run(setNotificationPrefs, { vault, prefs: { monthClosed: false } });
    await planNotifications(
      context(off.services, memoryScheduler("granted"), NOW, TODAY, "Europe/Warsaw"),
    );
    expect(offRead).not.toHaveBeenCalled();
    off.close();
    fixture.close();
  });

  it("warns about the same staleness once", async () => {
    const fixture = household();
    const scheduler = memoryScheduler("granted");
    const ctx = context(fixture.services, scheduler, NOW, TODAY, "Europe/Warsaw");
    await planNotifications(ctx);
    await planNotifications({ ...ctx, now: new Date(NOW.getTime() + 3_600_000) });
    expect(scheduler.delivered.filter((n) => n.thread === "stale_data")).toHaveLength(1);
    fixture.close();
  });
});

describe("planNotifications: the evening digest", () => {
  /** A monthly bill on the 14th (August to October), so the next one is due on Saturday 14 November. */
  function billed() {
    const fixture = moneyStore();
    importMoneyFacts(
      fixture.a,
      "PLN",
      MONEY_OWN_A,
      ["2026-08-14", "2026-09-14", "2026-10-14"].map((date, i) => ({
        date,
        amount: "-43.00",
        key: `synthetic-bill-${i}`,
      })),
    );
    fixture.services.device.run(setNotificationPrefs, {
      vault: MONEY_VAULT_A,
      prefs: { evening: true },
    });
    return fixture;
  }
  const evenings = (scheduler: ReturnType<typeof memoryScheduler>) =>
    [...scheduler.pending.values()]
      .filter((n) => n.thread === "evening" && n.data.vault === MONEY_VAULT_A)
      .map((n) => [n.id, n.body]);

  it("planned at 20:00 counts the bills due the day after tomorrow evening's digest", async () => {
    const fixture = billed();
    const scheduler = memoryScheduler("granted");
    // Thursday 12 November, 20:00 in Warsaw: the digest moves to Friday 19:00 and speaks about Saturday.
    await planNotifications(
      context(
        fixture.services,
        scheduler,
        new Date("2026-11-12T19:00:00Z"),
        "2026-11-12",
        "Europe/Warsaw",
      ),
    );
    expect(evenings(scheduler)).toEqual([
      [`cashu.${MONEY_VAULT_A}.evening.2026-11-13`, "1 bill due tomorrow."],
    ]);
    fixture.close();
  });

  it("is skipped when the day after its own day is empty, though tomorrow is not", async () => {
    const fixture = billed();
    const scheduler = memoryScheduler("granted");
    // Friday 13 November, 20:00: the digest would fire Saturday 19:00 about Sunday, which has no bill.
    await planNotifications(
      context(
        fixture.services,
        scheduler,
        new Date("2026-11-13T19:00:00Z"),
        "2026-11-13",
        "Europe/Warsaw",
      ),
    );
    expect(evenings(scheduler)).toEqual([]);
    fixture.close();
  });
});

describe("previewNotifications", () => {
  it("writes tonight's three digests of one vault a few seconds ahead, outside the planner's ids", () => {
    const fixture = moneyStore();
    importMoneyFacts(fixture.a, "PLN", MONEY_OWN_A, [
      { date: "2026-10-30", amount: "-42.00", key: "synthetic-1" },
      { date: "2026-11-10", amount: "-15.00", key: "synthetic-2" },
    ]);
    const now = new Date("2026-11-12T08:00:00Z");
    const preview = previewNotifications(
      {
        services: fixture.services,
        now,
        today: "2026-11-12",
        timeZone: "Europe/Warsaw",
        lang: "en",
        locale: "en-US",
      },
      MONEY_VAULT_A,
      5_000,
    );
    expect(preview.map((n) => [n.id, n.fireAt])).toEqual([
      [`cashu-preview.${MONEY_VAULT_A}.evening`, "2026-11-12T08:00:05.000Z"],
      [`cashu-preview.${MONEY_VAULT_A}.weekly`, "2026-11-12T08:00:05.000Z"],
      [`cashu-preview.${MONEY_VAULT_A}.month_closed`, "2026-11-12T08:00:05.000Z"],
    ]);
    expect(preview.every((n) => n.title === "cashU · Synthetic A")).toBe(true);
    expect(preview[0]?.body).toBe("1 payment to categorize.");
    expect(preview[2]?.body).toBe("October closed. Open cashU to see what you kept.");
    expect(
      previewNotifications(
        {
          services: fixture.services,
          now,
          today: "2026-11-12",
          timeZone: "Europe/Warsaw",
          lang: "en",
          locale: "en-US",
        },
        "c3000000000000000000000000000003",
        5_000,
      ),
    ).toEqual([]);
    fixture.close();
  });
});
