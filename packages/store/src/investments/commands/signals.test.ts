// Signal commands and queries (Python `store/signals.py`): applying a run's lifecycle actions on the
// lease holder (open / refresh / escalate / resolve / expire with the close payload keys of
// signals.py:59-72 and 200-205, R-S8), cooldown inputs, snooze and wake, rule runs and
// `is_current`. Synthetic data only.
import { describe, expect, it } from "vitest";
import {
  closedSignals,
  isCurrent,
  lastGoodRunGid,
  lastRun,
  openSignals,
  ruleRuns,
  signalByGid,
} from "../queries/signals.js";
import { recordDecision } from "./journal.js";
import {
  applySignalActions,
  RESOLVED_REASON,
  snoozeSignalCommand,
  wakeSnoozedSignals,
} from "./signals.js";
import { applyRaw, raw, rawGid, stock, vault } from "./testing/fixtures.js";

const cand = (dedupKey: string, extra: Record<string, unknown> = {}) => ({
  ruleId: dedupKey.split("|")[0],
  kind: "drawdown",
  dedupKey,
  severity: "info",
  message: "Spadek",
  payload: { drop: "0.1" },
  ...extra,
});
const AT = "2026-10-31T06:00:00.000Z";

function setup(holder = true) {
  const v = vault({ holder });
  const i = stock(v, "AAA", "PL0000000AAA");
  const run1 = rawGid(1);
  const run2 = rawGid(2);
  applyRaw(v, [raw.ruleRun(run1)]);
  return { v, i, run1, run2, read: v.store.read.bind(v.store) };
}

describe("applySignalActions", () => {
  it("is the lease holder's: elsewhere it refuses and writes nothing", () => {
    const { v, i, run1 } = setup(false);
    expect(
      v.run(applySignalActions, {
        run: run1,
        actions: [{ type: "create", candidate: cand(`r|i:${i}`), createdAt: AT }],
      }),
    ).toEqual({ ok: false, reason: "not_leader" });
  });

  it("opens, refreshes and escalates; returns the signals this device notifies", () => {
    const { v, i, run1, run2, read } = setup();
    const created = v.value(applySignalActions, {
      run: run1,
      notify: ["action"],
      actions: [
        { type: "create", candidate: cand(`r|i:${i}`, { instrument: i }), createdAt: AT },
        {
          type: "create",
          candidate: cand("cash_level", { severity: "action", polarity: "negative" }),
          createdAt: AT,
        },
      ],
    });
    const [a, b] = created.created as [string, string];
    expect(created.notify).toEqual([b]);
    expect(signalByGid(read, a)).toMatchObject({
      status: "active",
      instrument: i,
      firstSeenAt: "2026-10-31 06:00:00.000000",
      createdRun: run1,
      lastRun: run1,
      payload: { drop: "0.1" },
    });
    v.value(recordDecision, { action: "held", signals: [a] });
    expect(signalByGid(read, a)?.status).toBe("acknowledged");
    applyRaw(v, [raw.ruleRun(run2)]);
    const later = "2026-10-31T07:00:00.000Z";
    const out = v.value(applySignalActions, {
      run: run2,
      notify: ["action"],
      actions: [
        {
          type: "refresh",
          signal: b,
          candidate: cand("cash_level", { message: "Nowe" }),
          seenAt: later,
        },
        {
          type: "escalate",
          signal: a,
          candidate: cand(`r|i:${i}`, { severity: "action", instrument: i }),
          reactivate: true,
          seenAt: later,
        },
      ],
    });
    expect(out).toMatchObject({ refreshed: [b], escalated: [a], notify: [a] });
    expect(signalByGid(read, a)).toMatchObject({
      status: "active", // reactivated: the acknowledgement is cleared
      severity: "action",
      lastSeenAt: "2026-10-31 07:00:00.000000",
      lastRun: run2,
    });
    // Python `_fill` rewrites polarity too: the refresh carried the candidate's default
    expect(signalByGid(read, b)).toMatchObject({
      message: "Nowe",
      polarity: "neutral",
      lastRun: run2,
    });
  });

  it("resolve and removed-rule expire set the run; an age expire marks closed_by (no cooldown)", () => {
    const { v, i, run1, run2, read } = setup();
    const { created } = v.value(applySignalActions, {
      run: run1,
      actions: [
        { type: "create", candidate: cand(`a|i:${i}`), createdAt: AT },
        { type: "create", candidate: cand(`b|i:${i}`), createdAt: AT },
        { type: "create", candidate: cand(`c|i:${i}`), createdAt: AT },
      ],
    });
    const [a, b, c] = created as [string, string, string];
    applyRaw(v, [raw.ruleRun(run2)]);
    const out = v.run(applySignalActions, {
      run: run2,
      actions: [
        { type: "resolve", signal: a, resolvedAt: "2026-10-31T08:00:00.000Z" },
        { type: "expire", signal: b, expiredAt: "2026-10-31T08:00:00.000Z" },
        { type: "expire", signal: c, expiredAt: "2026-10-31T09:00:00.000Z", reason: "unverified" },
      ],
    });
    expect(out.ok && out.events.map((e) => e.data.reason)).toEqual([
      RESOLVED_REASON,
      "rule_removed",
      "unverified",
    ]);
    expect(signalByGid(read, a)).toMatchObject({
      status: "resolved",
      closedAt: "2026-10-31 08:00:00.000000",
      lastRun: run2,
    });
    expect(signalByGid(read, b)).toMatchObject({
      status: "expired",
      lastRun: run2,
      payload: { drop: "0.1" },
    });
    expect(signalByGid(read, c)).toMatchObject({
      status: "expired",
      lastRun: run1, // no run confirmed it: the last one that did stays
      payload: { drop: "0.1", closed_reason: "unverified", closed_by: "unverified" },
    });
    expect(
      closedSignals(read)
        .map((x) => x.dedupKey)
        .sort(),
    ).toEqual([`a|i:${i}`, `b|i:${i}`, `c|i:${i}`]);
    expect(
      closedSignals(read, { skipClosedBy: true })
        .map((x) => x.dedupKey)
        .sort(),
    ).toEqual([`a|i:${i}`, `b|i:${i}`]);
    expect(openSignals(read)).toEqual([]);
  });

  it("refuses an action on a signal that is not open (stale input); nothing is written", () => {
    const { v, i, run1, read } = setup();
    const { created } = v.value(applySignalActions, {
      run: run1,
      actions: [{ type: "create", candidate: cand(`a|i:${i}`), createdAt: AT }],
    });
    const [a] = created as [string];
    v.value(applySignalActions, {
      run: run1,
      actions: [{ type: "resolve", signal: a, resolvedAt: AT }],
    });
    const out = v.run(applySignalActions, {
      run: run1,
      actions: [
        { type: "create", candidate: cand(`z|i:${i}`), createdAt: AT },
        { type: "resolve", signal: a, resolvedAt: AT },
      ],
    });
    expect(out).toEqual({ ok: false, reason: "not_open" });
    expect(openSignals(read)).toEqual([]);
  });
});

describe("snooze and wake", () => {
  it("snoozes an open signal; the lease holder wakes it once the snooze passed", () => {
    const { v, i, run1, read } = setup();
    const { created } = v.value(applySignalActions, {
      run: run1,
      actions: [
        { type: "create", candidate: cand(`a|i:${i}`, { severity: "action" }), createdAt: AT },
      ],
    });
    const [a] = created as [string];
    v.value(recordDecision, { action: "held", signals: [a] });
    v.value(snoozeSignalCommand, { signal: a, until: "2026-10-31T12:30:00.123456Z" });
    expect(signalByGid(read, a)?.snoozedUntil).toBe("2026-10-31 12:30:00.123456");
    expect(v.value(wakeSnoozedSignals, { notify: ["action"] })).toEqual({ woken: [], notify: [] });
    v.env.advance(31 * 60_000);
    expect(v.value(wakeSnoozedSignals, { notify: ["action"] })).toEqual({
      woken: [a],
      notify: [a],
    });
    expect(signalByGid(read, a)).toMatchObject({ snoozedUntil: null, status: "active" });
    v.env.holder = false;
    expect(v.run(wakeSnoozedSignals, {})).toEqual({ ok: false, reason: "not_leader" });
    v.value(snoozeSignalCommand, { signal: a, until: null }); // the owner's: any device
    expect(v.run(snoozeSignalCommand, { signal: rawGid(77), until: null })).toEqual({
      ok: false,
      reason: "not_open",
    });
  });
});

describe("rule runs", () => {
  it("orders runs newest first; the last good run decides is_current", () => {
    const v = vault();
    const read = v.store.read.bind(v.store);
    expect(lastRun(read)).toBeUndefined();
    expect(isCurrent({ lastRun: rawGid(1) }, lastGoodRunGid(read))).toBe(true); // no good run yet
    applyRaw(v, [
      raw.ruleRun(rawGid(1), { startedAt: "2026-10-29T06:00:00.000Z" }),
      raw.ruleRun(rawGid(2), { startedAt: "2026-10-30T06:00:00.000Z", status: "partial" }),
      raw.ruleRun(rawGid(3), { startedAt: "2026-10-31T06:00:00.000Z", status: "failed" }),
    ]);
    expect(ruleRuns(read).map((r) => r.gid)).toEqual([rawGid(3), rawGid(2), rawGid(1)]);
    expect(ruleRuns(read, 1).map((r) => r.gid)).toEqual([rawGid(3)]);
    expect(lastRun(read)?.status).toBe("failed");
    const good = lastGoodRunGid(read);
    expect(good).toBe(rawGid(2));
    expect(isCurrent({ lastRun: rawGid(2) }, good)).toBe(true);
    expect(isCurrent({ lastRun: rawGid(1) }, good)).toBe(false);
    expect(isCurrent({ lastRun: null }, good)).toBe(true); // research signals carry no run
  });
});
