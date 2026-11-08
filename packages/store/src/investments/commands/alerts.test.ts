// Alert reads with the effective status (R-S2) and the alert signal close / reopen building blocks
// (Python `store/alerts.py`: close_open_signal, reopen_signal_closed_at, alert_counts,
// live_agent_alerts, the watchlist reads). Synthetic data only.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineCommand, ok } from "../../command.js";
import { gid, timestamp } from "../../events/v1/primitives.js";
import {
  alertByGid,
  alertCounts,
  alerts,
  deletedAlert,
  liveAgentAlerts,
  watchedInstrumentGids,
  watchedItemFor,
  watchlist,
  watchlistItem,
  watchRowFor,
} from "../queries/alerts.js";
import { closedSignals, openAlertSignals, signalByGid } from "../queries/signals.js";
import { alertRuleId, closeAlertSignal, reopenAlertSignal } from "./alerts.js";
import { recordDecision } from "./journal.js";
import { applyRaw, raw, rawGid, stock, vault } from "./testing/fixtures.js";

// Stand-ins for S22b's alert commands: the alert event and its signal event in one batch.
const muteAlert = defineCommand({
  id: "test.muteAlert",
  input: z.object({ alert: gid }),
  run(ctx, input) {
    const at = ctx.now();
    ctx.emit("alert.statusSet", input.alert, { status: "muted", snoozedUntil: null });
    return ok({ closed: closeAlertSignal(ctx, input.alert, "mute", at)?.gid ?? null, at });
  },
});
const unmuteAlert = defineCommand({
  id: "test.unmuteAlert",
  input: z.object({ alert: gid, closedAt: timestamp }),
  run(ctx, input) {
    ctx.emit("alert.statusSet", input.alert, { status: "active", snoozedUntil: null });
    return ok({ reopened: reopenAlertSignal(ctx, input.alert, input.closedAt)?.gid ?? null });
  },
});

describe("alert signal close and reopen", () => {
  it("closes the open alert signal with closed_by; a restore reopens it (acknowledged kept)", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    const alert = rawGid(1);
    const sig = rawGid(2);
    applyRaw(v, [raw.alertCreated(alert, null), raw.signalOpened(sig, alertRuleId(alert))]);
    v.value(recordDecision, { action: "held", signals: [sig] });
    expect(openAlertSignals(read).get(alert)?.gid).toBe(sig);
    const muted = v.value(muteAlert, { alert });
    expect(muted.closed).toBe(sig);
    expect(signalByGid(read, sig)).toMatchObject({
      status: "expired",
      payload: { closed_by: "mute" },
    });
    // an owner close never starts the alert's cooldown
    expect(closedSignals(read, { skipClosedBy: true })).toEqual([]);
    expect(v.value(muteAlert, { alert }).closed).toBeNull(); // nothing open any more
    v.env.advance(5000);
    expect(
      v.value(unmuteAlert, { alert, closedAt: "2026-10-31T11:00:00.000Z" }).reopened,
    ).toBeNull();
    expect(v.value(unmuteAlert, { alert, closedAt: muted.at }).reopened).toBe(sig);
    const back = signalByGid(read, sig);
    expect(back).toMatchObject({ status: "acknowledged", closedAt: null });
    expect(back?.payload).toEqual({});
  });
});

describe("alert reads show the effective status only", () => {
  it("expiry and the end of a snooze apply at the reader's now", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    const i = stock(v, "AAA", "PL0000000AAA");
    const [a1, a2, a3, a4] = [rawGid(1), rawGid(2), rawGid(3), rawGid(4)];
    applyRaw(v, [
      raw.alertCreated(a1, i, { source: "agent" }),
      raw.alertCreated(a2, null, { expiresAt: "2026-11-01T00:00:00.000Z" }),
      raw.alertCreated(a3, null, { source: "agent" }),
      raw.alertCreated(a4, i),
      {
        type: "alert.statusSet",
        gid: a3,
        data: { status: "snoozed", snoozedUntil: "2026-10-31T18:00:00.000Z" },
      },
      { type: "alert.deleted", gid: a4, data: {} },
    ]);
    const noon = "2026-10-31T12:00:00Z";
    expect(alerts(read, noon).map((a) => [a.gid, a.status])).toEqual([
      [a1, "active"],
      [a2, "active"],
      [a3, "snoozed"],
    ]);
    expect(alertCounts(read, noon)).toEqual({
      active: 2,
      triggered: 0,
      snoozed: 1,
      muted: 0,
      expired: 0,
      agentLive: 2,
    });
    const tomorrow = "2026-11-01T00:00:00Z";
    expect(alerts(read, tomorrow).map((a) => [a.status, a.snoozedUntil])).toEqual([
      ["active", null],
      ["expired", null], // expires_at <= now
      ["active", null], // the snooze ended
    ]);
    expect(alerts(read, tomorrow, ["expired"]).map((a) => a.gid)).toEqual([a2]);
    expect(liveAgentAlerts(read, tomorrow)).toBe(2);
    expect(alertByGid(read, a4, noon)).toBeUndefined();
    expect(deletedAlert(read, a4, noon)?.gid).toBe(a4);
    expect(deletedAlert(read, a1, noon)).toBeUndefined();
  });
});

describe("watchlist reads", () => {
  it("active rows oldest first; a removed row is only found by watchRowFor", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    const a = stock(v, "AAA", "PL0000000AAA");
    const b = stock(v, "BBB", "PL0000000BBB");
    applyRaw(v, [raw.watchAdded(v, a, { note: "obserwuje", tags: ["x"] })]);
    v.env.advance(1000);
    applyRaw(v, [raw.watchAdded(v, b), raw.watchRemoved(v, b)]);
    expect(watchlist(read).map((w) => [w.instrument, w.note, w.tags])).toEqual([
      [a, "obserwuje", ["x"]],
    ]);
    expect(watchedInstrumentGids(read)).toEqual(new Set([a]));
    expect(watchedItemFor(read, b)).toBeUndefined();
    expect(watchRowFor(read, b)?.removedAt).not.toBeNull();
    const row = watchRowFor(read, a);
    expect(row && watchlistItem(read, row.gid)?.instrument).toBe(a);
    expect(watchlistItem(read, watchRowFor(read, b)?.gid ?? "")).toBeUndefined();
  });
});
