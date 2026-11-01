// Actual Python reconcile_signals output on bounded synthetic inputs, including exact time edges.
import { expect, it } from "vitest";
import { type DateTime, formatDateTime, parseDateTime } from "../../dates.js";
import { loadVectors } from "../../testing/vectors.js";
import type { SignalSeverity, SignalStatus } from "../domain/enums.js";
import { type OpenSignal, reconcileSignals } from "./lifecycle.js";
import { Fired, NotFired, type RuleOutcome, type SignalCandidate, Skipped } from "./outcomes.js";

interface VectorInput {
  now: string;
  rules: { id: string; cooldownDays: number | null }[];
  open: {
    signalId: string;
    ruleId: string;
    dedupKey: string;
    severity: SignalSeverity;
    status: SignalStatus;
    lastSeenAt: string | null;
  }[];
  closed: { dedupKey: string; resolvedAt: string }[];
  outcomes: (
    | { type: "fired"; candidate: SignalCandidate }
    | { type: "not_fired" | "skipped"; ruleId: string; dedupKey: string | null }
  )[];
  maxDays: number | null;
}

function encode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    if ("date" in value && "microsecond" in value) return formatDateTime(value as DateTime);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
  }
  return value;
}

it.each(loadVectors("inv-rules-lifecycle").rows)(
  "matches Python lifecycle: %s",
  (_, raw, expected) => {
    const input = raw as VectorInput;
    const openSignals: OpenSignal[] = input.open.map((s) => ({
      ...s,
      lastSeenAt: s.lastSeenAt === null ? null : parseDateTime(s.lastSeenAt),
    }));
    const outcomes: RuleOutcome[] = input.outcomes.map((o) => {
      if (o.type === "fired") return new Fired(o.candidate);
      if (o.type === "not_fired") return new NotFired(o.ruleId, o.dedupKey);
      return new Skipped(o.ruleId, "synthetic skip", o.dedupKey);
    });
    let actual: unknown;
    try {
      const result = reconcileSignals({
        openSignals,
        outcomes,
        rules: input.rules,
        clock: () => parseDateTime(input.now),
        closedSignals: input.closed.map((s) => ({
          ...s,
          resolvedAt: parseDateTime(s.resolvedAt),
        })),
        maxUnverifiedDays: input.maxDays,
      });
      actual = encode({
        actions: result.actions,
        untouched: result.untouched,
        stats: result.stats,
      });
    } catch (error) {
      actual = { error: error instanceof Error ? error.name : "Error" };
    }
    expect(actual).toEqual(expected);
  },
);
