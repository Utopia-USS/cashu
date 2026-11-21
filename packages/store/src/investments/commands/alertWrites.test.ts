import { D, parseDateTime } from "@cashu/domain";
import { asInstrumentId, priceBar } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Command, defineCommand, runCommand, storeWriter } from "../../command.js";
import { viewHash } from "../../snapshot.js";
import { shuffled } from "../../testing/random.js";
import { openTestStore } from "../../testing/store.js";
import { alertByGid, alerts, deletedAlert } from "../queries/alerts.js";
import { closedSignals, openSignals, signalByGid } from "../queries/signals.js";
import { applyAlertChecks } from "./alertEvaluation.js";
import { createAlert, deleteAlert, restoreAlert, updateAlert } from "./alertWrites.js";
import { recordDecision } from "./journal.js";
import { applyRaw, otherVault, raw, stock, type Vault, vault } from "./testing/fixtures.js";

const NOW = "2026-10-31T12:00:00.123456Z";
function at<I, R>(v: Vault, command: Command<I, R>, input: unknown, now = NOW) {
  return runCommand(
    v.store,
    storeWriter(v.store),
    {
      ...command,
      run(ctx, parsed) {
        return command.run({ ...ctx, now: () => now }, parsed);
      },
    },
    input,
    v.env,
  );
}
function value<I, R>(v: Vault, command: Command<I, R>, input: unknown, now = NOW): R {
  const result = at(v, command, input, now);
  if (!result.ok) throw new Error(result.reason);
  return result.value;
}
function setup() {
  const v = vault();
  const instrument = stock(v, "AAA", "PL0000000AAA");
  applyRaw(v, [raw.watchAdded(v, instrument)]);
  const create = (extra: Record<string, unknown> = {}) =>
    value(v, createAlert, {
      kind: "price_above",
      instrument,
      title: "Synthetic alert",
      params: { level: 10 },
      ...extra,
    }).alert;
  return { v, instrument, create, read: v.store.read.bind(v.store) };
}
function evaluate(
  v: Vault,
  instrument: string,
  close: number,
  options: { now?: string; stale?: boolean } = {},
) {
  const command = defineCommand({
    id: "test.alertPass",
    input: z.object({}),
    run(ctx) {
      return applyAlertChecks(ctx, {
        now: parseDateTime(options.now ?? NOW),
        run: null,
        config: null,
        data: {
          asOf: "2026-10-31",
          bars: new Map([
            [
              asInstrumentId(instrument),
              [
                priceBar({
                  instrumentId: asInstrumentId(instrument),
                  date: options.stale ? "2026-10-01" : "2026-10-31",
                  close: D(String(close)),
                  source: "synthetic",
                }),
              ],
            ],
          ]),
          lang: "en",
        },
      });
    },
  });
  return at(v, command, {}, options.now ?? NOW);
}

describe("owner alert commands and leader evaluation", () => {
  it("normalizes tag/text, exposes effective reads and validates unknown/foreign inputs atomically", () => {
    const { v, instrument, create, read } = setup();
    v.env.holder = false;
    const alert = create({ title: "  Synthetic alert  ", tag: "  ŻÓŁĆ   Test " });
    expect(alertByGid(read, alert, NOW)).toMatchObject({
      title: "Synthetic alert",
      tag: "żółć test",
      status: "active",
    });
    expect(evaluate(v, instrument, 12)).toEqual({ ok: false, reason: "not_leader" });
    expect(
      at(v, updateAlert, { alert, changes: { kind: "price_below", title: "changed" } }),
    ).toEqual({ ok: false, reason: "unknown_field" });
    expect(alertByGid(read, alert, NOW)?.title).toBe("Synthetic alert");
    const foreign = stock(otherVault(), "OTHER", "PL0000000OTH");
    expect(
      at(v, createAlert, {
        kind: "price_above",
        instrument: foreign,
        title: "x",
        params: { level: 10 },
      }),
    ).toEqual({ ok: false, reason: "no_instrument" });
    expect(
      at(v, createAlert, { kind: "price_above", instrument, title: "x", params: { level: -1 } }),
    ).toEqual({ ok: false, reason: "alert_invalid" });
    expect(alerts(read, NOW)).toHaveLength(1);
  });

  it("creates once, refreshes, skips stale checks, resolves and respects cooldown equality", () => {
    const { v, instrument, create, read } = setup();
    const alert = create({ severity: "action", cooldownDays: 2 });
    const first = evaluate(v, instrument, 12);
    if (!first.ok) throw new Error(first.reason);
    const signal = first.value.applied.created[0] as string;
    expect(first.value.applied.notify).toEqual([signal]);
    const refresh = evaluate(v, instrument, 12);
    expect(refresh.ok && refresh.value.applied.refreshed).toEqual([signal]);
    expect(alertByGid(read, alert, NOW)?.status).toBe("triggered");
    const checked = alertByGid(read, alert, NOW)?.lastCheckedAt;
    const skip = evaluate(v, instrument, 12, { stale: true, now: "2026-11-01T12:00:00Z" });
    expect(skip.ok && skip.value.outcomes[0]?.type).toBe("skipped");
    expect(alertByGid(read, alert, NOW)?.lastCheckedAt).toBe(checked);
    const resolved = evaluate(v, instrument, 10);
    expect(resolved.ok && resolved.value.applied.resolved).toEqual([signal]);
    const suppressed = evaluate(v, instrument, 12, { now: "2026-11-02T12:00:00.123455Z" });
    expect(suppressed.ok && suppressed.value.reconciliation.stats.signals_suppressed).toBe(1);
    expect(alertByGid(read, alert, NOW)?.status).toBe("active");
    const reopened = evaluate(v, instrument, 12, { now: "2026-11-02T12:00:00.123456Z" });
    expect(reopened.ok && reopened.value.applied.created).toHaveLength(1);
    expect(openSignals(read)[0]?.gid).not.toBe(signal);
  });

  it("mutes/snoozes/deletes on any device and restores exactly the deletion episode with acknowledgement", () => {
    const { v, instrument, create, read } = setup();
    const alert = create();
    const first = evaluate(v, instrument, 12);
    if (!first.ok) throw new Error(first.reason);
    const signal = first.value.applied.created[0] as string;
    v.value(recordDecision, { action: "held", signals: [signal] });
    v.env.holder = false;
    value(v, deleteAlert, { alert });
    expect(deletedAlert(read, alert, NOW)).toBeDefined();
    expect(signalByGid(read, signal)).toMatchObject({
      status: "expired",
      payload: { closed_by: "delete" },
    });
    expect(closedSignals(read, { skipClosedBy: true })).toEqual([]);
    value(v, restoreAlert, { alert }, "2026-10-31T12:15:00.123456Z");
    expect(signalByGid(read, signal)).toMatchObject({ status: "acknowledged", closedAt: null });
    expect(signalByGid(read, signal)?.payload.closed_by).toBeUndefined();
    expect(value(v, restoreAlert, { alert }).alert).toBe(alert);
    value(v, deleteAlert, { alert });
    expect(at(v, restoreAlert, { alert }, "2026-10-31T12:15:00.123457Z")).toEqual({
      ok: false,
      reason: "undo_expired",
    });
    const foreign = otherVault();
    expect(at(foreign, restoreAlert, { alert })).toEqual({ ok: false, reason: "no_alert" });
  });

  it("owner closes start no cooldown, ended snoozes wake, and expiry closes only open episodes", () => {
    const { v, instrument, create, read } = setup();
    const alert = create({ cooldownDays: 30 });
    evaluate(v, instrument, 12);
    value(v, updateAlert, { alert, changes: { status: "muted" } });
    expect(openSignals(read)).toEqual([]);
    value(v, updateAlert, { alert, changes: { snoozeDays: 1 } });
    expect(alertByGid(read, alert, NOW)?.status).toBe("snoozed");
    const woken = evaluate(v, instrument, 12, { now: "2026-11-01T12:00:00.123456Z" });
    expect(woken.ok && woken.value.housekeeping.wokenAlerts).toBe(1);
    expect(woken.ok && woken.value.applied.created).toHaveLength(1);
    value(v, updateAlert, { alert, changes: { expiresInDays: 1 } });
    const expired = evaluate(v, instrument, 12, { now: "2026-11-01T12:00:00.123456Z" });
    expect(expired.ok && expired.value.housekeeping.expiredOpenSignals).toBe(1);
    expect(openSignals(read)).toEqual([]);
    const again = evaluate(v, instrument, 12, { now: "2026-11-02T12:00:00Z" });
    expect(again.ok && again.value.housekeeping.expiredOpenSignals).toBe(0);
    expect(again.ok && "alerts_expired" in again.value.stats).toBe(false);
    expect(alertByGid(read, alert, "2026-11-02T12:00:00Z")?.status).toBe("expired");
  });

  it("delegates both unrepresentable expired-state edits before any event", () => {
    const { v, instrument, create, read } = setup();
    const alert = create({ expiresInDays: 1 });
    evaluate(v, instrument, 12);
    const late = "2026-11-02T12:00:00Z";
    expect(at(v, updateAlert, { alert, changes: { expiresInDays: 2 } }, late)).toEqual({
      ok: false,
      reason: "delegate_expired_extension",
    });
    v.env.holder = false;
    expect(
      at(v, updateAlert, { alert, changes: { expiresInDays: 2, status: "active" } }, late),
    ).toEqual({ ok: false, reason: "delegate_expired_rearm" });
    expect(alertByGid(read, alert, late)?.status).toBe("expired");
  });

  it("age expiry rearms without confirming stale data or starting a cooldown", () => {
    const { v, instrument, create, read } = setup();
    const alert = create({ cooldownDays: 30 });
    const first = evaluate(v, instrument, 12);
    if (!first.ok) throw new Error(first.reason);
    const signal = first.value.applied.created[0];
    const checked = alertByGid(read, alert, NOW)?.lastCheckedAt;
    const boundary = evaluate(v, instrument, 12, {
      stale: true,
      now: "2026-11-14T12:00:00.123456Z",
    });
    expect(boundary.ok && boundary.value.reconciliation.untouched).toHaveLength(1);
    const expired = evaluate(v, instrument, 12, {
      stale: true,
      now: "2026-11-14T12:00:00.123457Z",
    });
    expect(expired.ok && expired.value.applied.expired).toEqual([signal]);
    expect(alertByGid(read, alert, NOW)).toMatchObject({
      status: "active",
      lastCheckedAt: checked,
    });
    const refired = evaluate(v, instrument, 12, { now: "2026-11-14T12:00:00.123458Z" });
    expect(refired.ok && refired.value.applied.created).toHaveLength(1);
  });

  it("keeps a woken alert active when stale prices skip the check, including a pre-end runtime evaluation", () => {
    for (const lateRuntime of [false, true]) {
      const { v, instrument, create, read } = setup();
      const alert = create();
      const first = evaluate(v, instrument, 12);
      if (!first.ok) throw new Error(first.reason);
      const checked = alertByGid(read, alert, NOW)?.lastCheckedAt;
      value(v, updateAlert, { alert, changes: { snoozeDays: 1 } });
      expect(openSignals(read)).toEqual([]);
      if (lateRuntime)
        applyRaw(v, [
          { type: "alert.evaluated", gid: alert, data: { triggered: true, lastCheckedAt: NOW } },
        ]);
      expect(alertByGid(read, alert, NOW)?.status).toBe("snoozed");
      const ended = "2026-11-01T12:00:00.123456Z";
      const result = evaluate(v, instrument, 12, { stale: true, now: ended });
      expect(result.ok && result.value.outcomes[0]?.type).toBe("skipped");
      expect(result.ok && result.value.housekeeping.wokenAlerts).toBe(1);
      expect(alertByGid(read, alert, ended)).toMatchObject({
        status: "active",
        snoozedUntil: null,
        lastCheckedAt: checked,
      });
      expect(openSignals(read)).toEqual([]);
      if (!result.ok) throw new Error(result.reason);
      expect(result.events.find((event) => event.type === "alert.evaluated")?.data).toEqual({
        triggered: false,
      });
      expect(evaluate(v, instrument, 12, { stale: true, now: ended }).ok).toBe(true);
      expect(alertByGid(read, alert, ended)?.status).toBe("active");
    }
  });

  it("rearms a restored triggered alert when no deletion episode could reopen", () => {
    const { v, create, read } = setup();
    const alert = create();
    applyRaw(v, [{ type: "alert.evaluated", gid: alert, data: { triggered: true } }]);
    value(v, deleteAlert, { alert });
    v.env.holder = false;
    const result = at(v, restoreAlert, { alert });
    expect(
      result.ok &&
        result.events.some((event) => event.type === "alert.restored" && event.data.rearm === true),
    ).toBe(true);
    expect(alertByGid(read, alert, NOW)?.status).toBe("active");
  });

  it("enforces agent cap and keeps restored tag without leaking mutations to another vault", () => {
    const { v, create, read } = setup();
    for (let i = 0; i < 50; i += 1) create({ source: "agent", tag: "test" });
    const all = alerts(read, NOW);
    const first = all[0];
    if (first === undefined) throw new Error("missing alert");
    expect(
      at(v, createAlert, {
        kind: "price_above",
        instrument: first.instrument,
        title: "cap",
        params: { level: 10 },
        source: "agent",
      }),
    ).toEqual({ ok: false, reason: "agent_alert_limit" });
    value(v, deleteAlert, { alert: first.gid });
    create({ source: "agent" });
    expect(at(v, restoreAlert, { alert: first.gid })).toEqual({
      ok: false,
      reason: "agent_alert_limit",
    });
    const other = otherVault();
    expect(alerts(other.store.read.bind(other.store), NOW)).toEqual([]);
  });

  it("converges native CRUD/evaluation events with reordered delivery, duplicates and rebuild", () => {
    const { v, instrument, create } = setup();
    const alert = create();
    expect(evaluate(v, instrument, 12).ok).toBe(true);
    value(v, deleteAlert, { alert });
    value(v, restoreAlert, { alert });
    value(v, updateAlert, { alert, changes: { tag: "test", status: "muted" } });
    value(v, updateAlert, { alert, changes: { status: "active" } });
    expect(evaluate(v, instrument, 12).ok).toBe(true);
    const expected = viewHash(v.store).hash;
    const events = v.store.foreignEvents(0, new Set(), 1000).events;
    for (const seed of [2, 13, 31]) {
      const copy = openTestStore();
      for (const event of shuffled(events, seed))
        expect(copy.applyEnvelopes([event, event]).rejected).toEqual([]);
      expect(viewHash(copy).hash).toBe(expected);
      copy.rebuild();
      expect(viewHash(copy).hash).toBe(expected);
      copy.close();
    }
  });
});
