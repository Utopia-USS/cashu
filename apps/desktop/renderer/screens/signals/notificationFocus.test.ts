import type { ReadySignals, SignalRow } from "@cashu/store/investments/signals-screen";
import { expect, it } from "vitest";
import { notificationSignalGroup } from "./notificationFocus.js";

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
    instrument: "synthetic-instrument",
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

function queried(open: SignalRow[]): ReadySignals {
  return { open, held: [] } as unknown as ReadySignals;
}

it("opens only the group containing the exact live signal", () => {
  expect(notificationSignalGroup(queried([signal("other"), signal("wanted")]), "wanted")).toBe(
    "i:synthetic-instrument",
  );
  expect(notificationSignalGroup(queried([signal("other")]), "wanted")).toBeNull();
});

it("falls back to the neutral list for hidden, decided, snoozed or closed signals", () => {
  for (const patch of [
    { current: false },
    { decisions: [{ gid: "synthetic-decision" }] },
    { snoozed: true },
    { status: "closed" as const },
  ]) {
    expect(
      notificationSignalGroup(queried([signal("wanted", patch as Partial<SignalRow>)]), "wanted"),
    ).toBeNull();
  }
});
