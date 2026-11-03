/** Source grouping and filters over canonical signal references. No money is computed here. */
import type { SignalRow } from "@cashu/store/investments/signals-screen";
export type SignalFilter = "all" | "positive" | "negative";
export type SignalGroup = {
  readonly key: string;
  readonly instrument: string | null;
  readonly signals: readonly SignalRow[];
  readonly live: readonly SignalRow[];
  readonly primary: SignalRow | null;
  readonly state: "positive" | "negative" | "neutral" | "mixed";
  readonly settled: boolean;
  readonly scope: "portfolio" | "watched";
};
export function signalGroups(
  rows: readonly SignalRow[],
  held: readonly string[],
  filter: SignalFilter,
): SignalGroup[] {
  // Native reads already encode newest creation-anchor order, which supplies source id ties.
  const order = new Map(rows.map((row, index) => [row.gid, index]));
  const byTime = (a: SignalRow, b: SignalRow) =>
    b.firstSeenAt.localeCompare(a.firstSeenAt) ||
    Number(a.severity !== "action") - Number(b.severity !== "action") ||
    (order.get(a.gid) ?? 0) - (order.get(b.gid) ?? 0);
  const by = new Map<string, SignalRow[]>();
  for (const row of rows) {
    if (filter !== "all" && (row.polarity === "positive") !== (filter === "positive")) continue;
    const key =
      row.instrument !== null
        ? `i:${row.instrument}`
        : row.kind === "allocation_drift"
          ? `b:${String(row.payload.bucket_id ?? "")}`
          : `k:${row.kind}`;
    by.set(key, [...(by.get(key) ?? []), row]);
  }
  return [...by]
    .map(([key, source]): SignalGroup => {
      const signals = [...source].sort(byTime),
        first = signals[0];
      const live = signals.filter((row) => row.decisions.length === 0 && !row.snoozed);
      const polarities = (live.length ? live : signals).map((row) => row.polarity);
      const state = polarities.includes("positive")
        ? polarities.every((p) => p === "positive")
          ? "positive"
          : "mixed"
        : polarities.includes("negative")
          ? "negative"
          : "neutral";
      return {
        key,
        signals,
        live,
        primary: live[0] ?? null,
        instrument: first?.instrument ?? null,
        state,
        settled: live.length === 0,
        scope:
          first?.instrument == null || held.includes(first.instrument) ? "portfolio" : "watched",
      };
    })
    .sort((a, b) => {
      const left = a.primary ?? a.signals[0],
        right = b.primary ?? b.signals[0];
      return Number(a.settled) - Number(b.settled) || (left && right ? byTime(left, right) : 0);
    });
}
