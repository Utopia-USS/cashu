import type { ReadySignals, SignalRow } from "@cashu/store/investments/signals-screen";
import { expect, it } from "vitest";
import {
  alertHistoryRows,
  alertSignalObserved,
  decisionUndoOpen,
  journalTimeline,
  signalGroups,
} from "./presentation.js";

it("keeps a newly saved UTC decision undoable across Warsaw local time", () => {
  expect(decisionUndoOpen("2026-11-03T11:28:00Z", "2026-11-03 11:27:00.000000")).toBe(true);
  expect(decisionUndoOpen("2026-11-03T11:43:01Z", "2026-11-03 11:27:00.000000")).toBe(false);
});

function signal(gid: string, patch: Partial<SignalRow> = {}): SignalRow {
  return {
    gid,
    ruleId: "rule",
    kind: "price_below",
    dedupKey: gid,
    severity: "info",
    polarity: "negative",
    status: "active",
    message: "Synthetic",
    instrument: "instrument",
    account: null,
    payload: {},
    firstSeenAt: "2026-11-01T12:00:00Z",
    lastSeenAt: "2026-11-01T12:00:00Z",
    createdRun: null,
    lastRun: null,
    acknowledgedAt: null,
    closedAt: null,
    snoozedUntil: null,
    source: "rule",
    instrumentLabel: "Synthetic",
    messageCode: null,
    messageParams: null,
    alert: null,
    note: null,
    snoozed: false,
    current: true,
    decisions: [],
    ...patch,
  };
}

it("uses UTC storage instants for the alert history year boundary", () => {
  const rows = [
    signal("included", { source: "alert", firstSeenAt: "2025-11-03 11:30:00.000000" }),
    signal("old", { source: "alert", firstSeenAt: "2025-11-03 10:59:00.000000" }),
    signal("rule", { firstSeenAt: "2025-11-03 11:30:00.000000" }),
  ];
  expect(alertHistoryRows(rows, "2026-11-03T11:00:00Z").map((row) => row.gid)).toEqual([
    "included",
  ]);
});

it("keeps neutral signals out of the risk filter", () => {
  const rows = [signal("risk"), signal("neutral", { polarity: "neutral" })];
  expect(
    signalGroups(rows, [], "negative").flatMap((group) => group.signals.map((row) => row.gid)),
  ).toEqual(["risk"]);
});
it("groups source signals without promoting snoozed rows and keeps allocation buckets distinct", () => {
  const snoozed = signal("snoozed", { snoozed: true, severity: "action" });
  const positive = signal("positive", { polarity: "positive", severity: "action" });
  const negative = signal("negative");
  const bucket = (id: string) =>
    signal(id, { instrument: null, kind: "allocation_drift", payload: { bucket_id: id } });
  const groups = signalGroups(
    [snoozed, positive, negative, bucket("a"), bucket("b")],
    ["instrument"],
    "all",
  );
  expect(groups).toHaveLength(3);
  expect(groups[0]).toMatchObject({
    instrument: "instrument",
    primary: positive,
    state: "mixed",
    scope: "portfolio",
    settled: false,
  });
  expect(groups[0]?.live.map((row) => row.gid)).toEqual(["positive", "negative"]);
  expect(signalGroups([snoozed, positive, negative], [], "positive")[0]).toMatchObject({
    state: "positive",
    scope: "watched",
  });
});
it("groups the complete journal by local month and summarizes actual yearly actions", () => {
  const decisionRow = (
    gid: string,
    createdAt: string,
    action: string,
    signals: string[],
  ): ReadySignals["decisions"][number] => ({
    gid,
    createdAt,
    action,
    signals,
    signal: signals[0] ?? null,
    instrument: null,
    account: null,
    quantity: null,
    price: null,
    currency: null,
    reason: null,
  });
  const bought = decisionRow("buy", "2026-01-03T12:00:00Z", "bought", ["s1"]);
  const held = decisionRow("hold", "2026-02-03T12:00:00Z", "held", []);
  const expired = signal("s1", { firstSeenAt: "2026-01-02T12:00:00Z", status: "expired" });
  const rows = journalTimeline([bought, held], [expired], "all");
  expect(rows.map((row) => row.kind)).toEqual([
    "year",
    "month",
    "decision",
    "month",
    "decision",
    "signal",
  ]);
  expect(rows[0]).toMatchObject({
    year: "2026",
    decisions: 2,
    signals: 1,
    actions: [
      ["held", 1],
      ["bought", 1],
    ],
  });
  expect(journalTimeline([bought], [expired], "signals").map((row) => row.kind)).toEqual([
    "year",
    "month",
    "signal",
  ]);
});
it("projects saved trigger values from their payload after the alert record is gone", () => {
  expect(
    alertSignalObserved(
      signal("p", { payload: { alert_kind: "price_above", close: "148.625", currency: "PLN" } }),
    ),
  ).toEqual({ value: "148.625", unit: "price", currency: "PLN" });
  expect(
    alertSignalObserved(
      signal("c", { payload: { alert_kind: "change_pct", change: -0.121, close: "88" } }),
    ),
  ).toEqual({ value: "-0.121", unit: "ratio", currency: null });
  expect(
    alertSignalObserved(signal("v", { payload: { alert_kind: "volume_spike", ratio: 3.2 } })),
  ).toEqual({ value: "3.2", unit: "multiple", currency: null });
});
