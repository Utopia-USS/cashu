import type { SignalRow } from "@cashu/store/investments/signals-screen";
import { expect, it } from "vitest";
import { signalGroups } from "./presentation.js";

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
