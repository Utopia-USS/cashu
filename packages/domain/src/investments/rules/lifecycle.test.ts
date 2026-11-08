// Test-for-test port of test_rules_signal_lifecycle.py (12) and test_rules_unverified.py (5).
import { describe, expect, it } from "vitest";
import { addMicroseconds, parseDateTime } from "../../dates.js";
import type { SignalSeverity, SignalStatus } from "../domain/enums.js";
import { type OpenSignal, reconcileSignals, UNVERIFIED } from "./lifecycle.js";
import { Fired, NotFired, type RuleOutcome, Skipped } from "./outcomes.js";

const NOW = parseDateTime("2026-10-02T06:00:00+00:00");
const CONC_RULE = { id: "conc", cooldownDays: null };
const RULES = [CONC_RULE, { id: "cash", cooldownDays: 7 }];
const PKN = "conc|i:i-PKN",
  CDR = "conc|i:i-CDR",
  CASH = "cash";
function fired(ruleId: string, dedupKey: string, severity: SignalSeverity = "info"): Fired {
  return new Fired({
    ruleId,
    kind: ruleId === "cash" ? "cash_level" : "position_concentration",
    dedupKey,
    severity,
    message: `${dedupKey} fired`,
    instrumentId: null,
    accountId: null,
    payload: {},
    polarity: "neutral",
  });
}
function opened(
  dedupKey = PKN,
  ruleId = "conc",
  severity: SignalSeverity = "info",
  status: SignalStatus = "active",
): OpenSignal {
  return { signalId: `s-${dedupKey}`, ruleId, dedupKey, severity, status };
}
function run(
  outcomes: readonly RuleOutcome[],
  openSignals: readonly OpenSignal[] = [],
  rules = RULES,
  now = NOW,
  closedSignals: { dedupKey: string; resolvedAt: typeof NOW }[] = [],
) {
  return reconcileSignals({ outcomes, openSignals, rules, clock: () => now, closedSignals });
}

describe("test_rules_signal_lifecycle.py", () => {
  it("a_new_dedup_key_creates_a_signal", () => {
    const result = run([fired("conc", PKN), new NotFired("conc", CDR)]);
    expect(result.actions).toEqual([
      { type: "create", candidate: fired("conc", PKN).candidate, createdAt: NOW },
    ]);
    expect(result.stats).toEqual({
      signals_new: 1,
      signals_escalated: 0,
      signals_refreshed: 0,
      signals_resolved: 0,
      signals_expired: 0,
      signals_suppressed: 0,
    });
  });
  it("the_same_key_firing_again_refreshes", () => {
    const result = run([fired("conc", PKN)], [opened()]);
    expect(result.created).toEqual([]);
    expect(result.refreshed).toEqual([
      {
        type: "refresh",
        signalId: `s-${PKN}`,
        candidate: fired("conc", PKN).candidate,
        seenAt: NOW,
      },
    ]);
  });
  it("a_lower_severity_is_a_plain_refresh", () => {
    const result = run([fired("conc", PKN)], [opened(PKN, "conc", "action")]);
    expect(result.refreshed).toHaveLength(1);
    expect(result.escalated).toEqual([]);
  });
  it("a_higher_severity_escalates_and_reactivates_an_acknowledged_signal", () => {
    const result = run(
      [fired("conc", PKN), fired("conc", PKN, "action")],
      [opened(PKN, "conc", "info", "acknowledged")],
    );
    expect(result.escalated).toEqual([
      {
        type: "escalate",
        signalId: `s-${PKN}`,
        candidate: fired("conc", PKN, "action").candidate,
        previousSeverity: "info",
        reactivate: true,
        seenAt: NOW,
      },
    ]);
    expect(result.refreshed).toEqual([]);
    expect(run([fired("conc", PKN, "action")], [opened()]).escalated[0]?.reactivate).toBe(false);
  });
  it("not_fired_resolves_its_scope_the_whole_rule_and_vanished_scopes", () => {
    const result = run(
      [fired("conc", PKN), new NotFired("conc", CDR), new NotFired("cash")],
      [opened(), opened(CDR), opened(CASH, "cash")],
    );
    expect(result.resolved.map((a) => [a.dedupKey, a.resolvedAt])).toEqual([
      [CDR, NOW],
      [CASH, NOW],
    ]);
    expect(run([new NotFired("conc", CDR)], [opened()]).resolved).toEqual([
      { type: "resolve", signalId: `s-${PKN}`, ruleId: "conc", dedupKey: PKN, resolvedAt: NOW },
    ]);
  });
  it("skipped_leaves_open_signals_untouched_and_absent_rules_too", () => {
    const open = [opened(), opened(CDR), opened(CASH, "cash")];
    const result = run([new Skipped("conc", "stale", PKN), new NotFired("conc", CDR)], open);
    expect(result.resolved.map((a) => a.dedupKey)).toEqual([CDR]);
    expect(result.untouched.map((s) => s.dedupKey)).toEqual([PKN, CASH]);
    const whole = run([new Skipped("conc", "stale"), new Skipped("cash", "stale")], open);
    expect(whole.actions).toEqual([]);
    expect(whole.untouched).toHaveLength(3);
  });
  it("a_skipped_scope_never_resolves_even_with_other_outcomes_of_the_rule", () => {
    const result = run([new Skipped("conc", "stale", PKN), fired("conc", CDR)], [opened()]);
    expect(result.resolved).toEqual([]);
    expect(result.actions.map((a) => a.type)).toEqual(["create"]);
  });
  it("cooldown_suppresses_a_key_resolved_recently", () => {
    const at = parseDateTime("2026-09-25T07:00:00+00:00");
    const closed = [
      { dedupKey: CASH, resolvedAt: at },
      { dedupKey: CASH, resolvedAt: parseDateTime("2026-09-02T06:00:00+00:00") },
    ];
    const result = run([fired("cash", CASH)], [], RULES, NOW, closed);
    expect(result.created).toEqual([]);
    expect(result.suppressed).toEqual([
      {
        type: "suppress",
        candidate: fired("cash", CASH).candidate,
        cooldownUntil: parseDateTime("2026-10-02T07:00:00+00:00"),
      },
    ]);
    expect(
      run(
        [fired("cash", CASH)],
        [],
        RULES,
        parseDateTime("2026-10-02T07:00:00+00:00"),
        closed,
      ).actions.map((a) => a.type),
    ).toEqual(["create"]);
  });
  it("rules_without_cooldown_reopen_immediately", () => {
    expect(
      run([fired("conc", PKN)], [], RULES, NOW, [
        { dedupKey: PKN, resolvedAt: addMicroseconds(NOW, -1) },
      ]).actions.map((a) => a.type),
    ).toEqual(["create"]);
  });
  it("open_signals_of_removed_rules_expire", () => {
    const result = run([fired("conc", PKN)], [opened(), opened(CASH, "cash")], [CONC_RULE]);
    expect(result.expired).toEqual([
      {
        type: "expire",
        signalId: `s-${CASH}`,
        ruleId: "cash",
        dedupKey: CASH,
        expiredAt: NOW,
        reason: null,
      },
    ]);
    expect(result.refreshed).toHaveLength(1);
  });
  it("actions_are_ordered_fired_first_then_closures", () => {
    expect(
      run(
        [new NotFired("conc", CDR), fired("conc", PKN)],
        [opened(CDR), opened(CASH, "cash")],
        [CONC_RULE],
      ).actions.map((a) => a.type),
    ).toEqual(["create", "resolve", "expire"]);
  });
  it("the_clock_is_called_once_and_duplicate_open_keys_are_rejected", () => {
    let calls = 0;
    reconcileSignals({
      outcomes: [fired("conc", PKN)],
      openSignals: [],
      rules: RULES,
      clock: () => {
        calls++;
        return NOW;
      },
    });
    expect(calls).toBe(1);
    expect(() => run([], [opened(), opened()])).toThrow("share the dedup key");
  });
});

describe("test_rules_unverified.py", () => {
  const open = (days: number | null): OpenSignal => ({
    ...opened(),
    lastSeenAt: days === null ? null : addMicroseconds(NOW, -days * 86400_000_000),
  });
  const age = (
    outcomes: readonly RuleOutcome[],
    signal: OpenSignal,
    maxUnverifiedDays: number | null = 14,
  ) =>
    reconcileSignals({
      outcomes,
      openSignals: [signal],
      rules: RULES,
      clock: () => NOW,
      maxUnverifiedDays,
    });
  it("a_skipped_signal_older_than_the_limit_expires_as_unverified", () => {
    const result = age([new Skipped("conc", "stale", PKN)], open(15));
    expect(result.expired).toEqual([
      {
        type: "expire",
        signalId: `s-${PKN}`,
        ruleId: "conc",
        dedupKey: PKN,
        expiredAt: NOW,
        reason: UNVERIFIED,
      },
    ]);
    expect(result.untouched).toEqual([]);
    expect(result.stats.signals_expired).toBe(1);
  });
  it("whole_rule_skip_and_an_absent_rule_count_too", () => {
    expect(age([new Skipped("conc", "invalid")], open(20)).expired[0]?.reason).toBe(UNVERIFIED);
    expect(age([], open(20)).expired[0]?.reason).toBe(UNVERIFIED);
  });
  it("within_the_limit_or_without_a_limit_it_stays_untouched", () => {
    for (const [days, limit] of [
      [14, 14],
      [13.9, 14],
      [100, null],
    ] as const) {
      const result = age([new Skipped("conc", "stale", PKN)], open(days), limit);
      expect(result.actions).toEqual([]);
      expect(result.untouched).toHaveLength(1);
    }
    expect(age([new Skipped("conc", "stale", PKN)], open(null)).actions).toEqual([]);
  });
  it("a_confirmed_or_resolved_signal_never_expires_by_age", () => {
    expect(age([fired("conc", PKN)], open(40)).actions.map((a) => a.type)).toEqual(["refresh"]);
    expect(
      age([new Skipped("conc", "other", "conc|i:other")], open(40)).actions.map((a) => a.type),
    ).toEqual(["resolve"]);
  });
  it("a_removed_rule_keeps_the_plain_expiry", () => {
    const result = reconcileSignals({
      openSignals: [open(40)],
      outcomes: [],
      rules: [],
      clock: () => NOW,
      maxUnverifiedDays: 14,
    });
    expect(result.expired[0]?.reason).toBeNull();
  });
});

it("retains first fired key insertion order and equal-rank first candidate; fired wins removed/skip", () => {
  const first = fired("conc", PKN),
    stronger = fired("conc", PKN, "action");
  const tied = new Fired({ ...stronger.candidate, message: "later tie" });
  const result = run(
    [first, fired("cash", CASH), stronger, tied, new Skipped("conc", "stale")],
    [opened()],
    [],
  );
  expect(result.actions.map((a) => ("candidate" in a ? a.candidate.dedupKey : null))).toEqual([
    PKN,
    CASH,
  ]);
  expect(result.escalated[0]?.candidate).toBe(stronger.candidate);
});
it("preserves an opaque persistence id without coercion", () => {
  const id = { opaque: "synthetic" };
  const result = reconcileSignals({
    openSignals: [{ ...opened(), signalId: id }],
    outcomes: [new NotFired("conc")],
    rules: RULES,
    clock: () => NOW,
  });
  expect(result.resolved[0]?.signalId).toBe(id);
});
