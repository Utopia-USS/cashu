// Alerts (S25 spec 4.10, D-S1; scenarios AL1-AL3, G5). Synthetic data only.
import { alerts as domainAlerts } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import type { Store } from "../materialize.js";
import { openTestStore } from "../testing/store.js";
import { converge, DEV_B, Events, instrument, row, ulid } from "./testing/kit.js";

const AL = ulid(1);
const T0 = "2026-11-01T12:00:00.000Z";
const T1 = "2026-11-08T12:00:00.000Z";

const effective = (store: Store, now: string) => {
  const r = row(store, "alerts", AL) as unknown as domainAlerts.AlertStatusRow;
  return domainAlerts.effectiveAlertStatus(r, now);
};

describe("alerts", () => {
  it("creates with owner config, active, created_at = updated_at", () => {
    const store = openTestStore();
    const ev = new Events();
    const i = instrument(ev, ["xtb", "ALR"]);
    store.applyEnvelopes(i.events);
    const r = store.applyEnvelopes([
      ev.make(
        "alert.created",
        AL,
        {
          instrument: i.gid,
          scope: "instrument",
          kind: "price_below",
          params: { threshold: "10" },
          expiresAt: T1,
          cooldownDays: 3,
        },
        { wall: 10 },
      ),
    ]);
    expect([...r.touchedTables]).toEqual(["alerts"]);
    expect(row(store, "alerts", AL)).toEqual({
      gid: AL,
      instrument_id: i.gid,
      scope: "instrument",
      kind: "price_below",
      params: { threshold: "10" },
      polarity: "negative",
      severity: "info",
      title: "Waga powyzej 20%",
      note: null,
      source: "user",
      created_by: "app",
      status: "active",
      cooldown_days: 3,
      expires_at: "2026-11-08 12:00:00.000000",
      snoozed_until: null,
      last_triggered_at: null,
      last_checked_at: null,
      last_value: null,
      created_at: "2026-10-31 12:00:00.010000",
      updated_at: "2026-10-31 12:00:00.010000",
      deleted_at: null,
    });
  });

  it("updated patches config and bumps updated_at; evaluated sets runtime without a bump", () => {
    const store = openTestStore();
    const ev = new Events();
    store.applyEnvelopes([
      ev.make("alert.created", AL, {}, { wall: 10 }),
      ev.make("alert.updated", AL, { title: "Nowy", note: "x", expiresAt: null }, { wall: 20 }),
      ev.make(
        "alert.evaluated",
        AL,
        { triggered: true, lastCheckedAt: T0, lastValue: "0.25", lastTriggeredAt: T0 },
        { wall: 30 },
      ),
    ]);
    expect(row(store, "alerts", AL)).toMatchObject({
      title: "Nowy",
      note: "x",
      expires_at: null,
      status: "triggered",
      last_checked_at: "2026-11-01 12:00:00.000000",
      last_value: "0.25",
      last_triggered_at: "2026-11-01 12:00:00.000000",
      updated_at: "2026-10-31 12:00:00.020000",
    });
  });

  it("statusSet: muted / snoozed clear triggered, active keeps it; delete is SOFT without a bump", () => {
    const store = openTestStore();
    const ev = new Events();
    store.applyEnvelopes([
      ev.make("alert.created", AL, {}, { wall: 10 }),
      ev.make("alert.evaluated", AL, { triggered: true }, { wall: 20 }),
      ev.make("alert.statusSet", AL, { status: "active", snoozedUntil: null }, { wall: 30 }),
    ]);
    expect(row(store, "alerts", AL)?.status).toBe("triggered");
    store.applyEnvelopes([
      ev.make("alert.statusSet", AL, { status: "muted", snoozedUntil: null }, { wall: 40 }),
      ev.make("alert.statusSet", AL, { status: "active", snoozedUntil: null }, { wall: 50 }),
    ]);
    expect(row(store, "alerts", AL)).toMatchObject({
      status: "active",
      updated_at: "2026-10-31 12:00:00.050000",
    });
    store.applyEnvelopes([ev.make("alert.deleted", AL, {}, { wall: 60 })]);
    expect(row(store, "alerts", AL)).toMatchObject({
      deleted_at: "2026-10-31 12:00:00.060000",
      updated_at: "2026-10-31 12:00:00.050000",
    });
  });

  it("restored clears deleted_at; rearm also clears triggered (S25-F6)", () => {
    const store = openTestStore();
    const ev = new Events();
    store.applyEnvelopes([
      ev.make("alert.created", AL, {}, { wall: 10 }),
      ev.make("alert.evaluated", AL, { triggered: true }, { wall: 20 }),
      ev.make("alert.deleted", AL, {}, { wall: 30 }),
      ev.make("alert.restored", AL, {}, { wall: 40 }),
    ]);
    expect(row(store, "alerts", AL)).toMatchObject({ deleted_at: null, status: "triggered" });
    store.applyEnvelopes([
      ev.make("alert.deleted", AL, {}, { wall: 50 }),
      ev.make("alert.restored", AL, { rearm: true }, { wall: 60 }),
    ]);
    expect(row(store, "alerts", AL)).toMatchObject({
      deleted_at: null,
      status: "active",
      updated_at: "2026-10-31 12:00:00.060000",
    });
  });

  it("AL1: an evaluation at or after the snooze end wakes the alert, an earlier one does not", () => {
    const ev = new Events();
    const base = [
      ev.make("alert.created", AL, {}, { wall: 10 }),
      ev.make("alert.statusSet", AL, { status: "snoozed", snoozedUntil: T1 }, { wall: 20 }),
    ];
    converge(
      [
        ...base,
        ev.make("alert.evaluated", AL, { triggered: false, lastCheckedAt: T0 }, { wall: 30 }),
      ],
      (store) => {
        expect(row(store, "alerts", AL)).toMatchObject({
          status: "snoozed",
          snoozed_until: "2026-11-08 12:00:00.000000",
        });
        expect(effective(store, T0).status).toBe("snoozed");
        expect(effective(store, T1)).toEqual({ status: "active", snoozed_until: null });
      },
    );
    converge(
      [
        ...base,
        ev.make("alert.evaluated", AL, { triggered: true, lastCheckedAt: T1 }, { wall: 40 }),
      ],
      (store) => {
        expect(row(store, "alerts", AL)).toMatchObject({
          status: "triggered",
          snoozed_until: null,
        });
      },
    );
  });

  it("AL2: a mute concurrent with a triggering evaluation reads muted in every order", () => {
    const a = new Events();
    const leader = new Events(DEV_B, "01JB");
    const events = [
      a.make("alert.created", AL, {}, { wall: 10 }),
      a.make("alert.statusSet", AL, { status: "muted", snoozedUntil: null }, { wall: 30 }),
      leader.make("alert.evaluated", AL, { triggered: true, lastCheckedAt: T0 }, { wall: 31 }),
    ];
    converge(events, (store) => {
      expect(row(store, "alerts", AL)?.status).toBe("muted");
      expect(effective(store, T1).status).toBe("muted");
    });
  });

  it("AL3: delete + restore{rearm} + reopened signal against a concurrent evaluation", () => {
    const a = new Events();
    const leader = new Events(DEV_B, "01JB");
    const S = ulid(2);
    const key = `alert:${AL}`;
    const events = [
      a.make("alert.created", AL, {}, { wall: 10 }),
      leader.make("alert.evaluated", AL, { triggered: true, lastCheckedAt: T0 }, { wall: 20 }),
      leader.make("signal.opened", S, { ruleId: key, dedupKey: key }, { wall: 21 }),
      a.make("alert.deleted", AL, {}, { wall: 30 }),
      a.make("signal.closed", S, { status: "expired", reason: "delete" }, { wall: 31 }),
      a.make("alert.restored", AL, { rearm: true }, { wall: 40 }),
      a.make("signal.reopened", S, { reason: "alert_restored" }, { wall: 41 }),
      leader.make("alert.evaluated", AL, { triggered: true, lastCheckedAt: T1 }, { wall: 42 }),
    ];
    converge(events, (store) => {
      expect(row(store, "alerts", AL)).toMatchObject({ status: "triggered", deleted_at: null });
      expect(row(store, "inv_signals", S)?.status).toBe("active");
    });
  });

  it("G5: genesis-shaped snoozed, triggered and expired alerts fold to the Python row shape", () => {
    const ev = new Events();
    const stamps = {
      created_at: "2026-01-01T00:00:00.000000Z",
      updated_at: "2026-02-01T00:00:00.000000Z",
    };
    const snoozed = ulid(11);
    const triggered = ulid(12);
    const expired = ulid(13);
    const events = [
      ev.make("alert.created", snoozed, { stamps }, { wall: 1 }),
      ev.make(
        "alert.statusSet",
        snoozed,
        { status: "snoozed", snoozedUntil: T1, stamps: { updated_at: stamps.updated_at } },
        { wall: 2 },
      ),
      ev.make("alert.evaluated", snoozed, { triggered: false, lastCheckedAt: T0 }, { wall: 3 }),
      ev.make("alert.created", triggered, { stamps }, { wall: 4 }),
      ev.make(
        "alert.evaluated",
        triggered,
        { triggered: true, lastCheckedAt: T0, lastValue: "9.5", lastTriggeredAt: T0 },
        { wall: 5 },
      ),
      ev.make("alert.created", expired, { stamps, expiresAt: T0 }, { wall: 6 }),
    ];
    converge(events, (store) => {
      expect(row(store, "alerts", snoozed)).toMatchObject({
        status: "snoozed",
        snoozed_until: "2026-11-08 12:00:00.000000",
        updated_at: "2026-02-01 00:00:00.000000",
      });
      expect(row(store, "alerts", triggered)).toMatchObject({
        status: "triggered",
        created_at: "2026-01-01 00:00:00.000000",
        updated_at: "2026-02-01 00:00:00.000000",
      });
      const exp = row(store, "alerts", expired) as unknown as domainAlerts.AlertStatusRow;
      expect(exp.status).toBe("active");
      expect(domainAlerts.effectiveAlertStatus(exp, T0).status).toBe("expired");
    });
  });
});
