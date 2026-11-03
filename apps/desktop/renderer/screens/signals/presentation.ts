/** Source grouping and filters over canonical signal references. No money is computed here. */
import type { ReadySignals, SignalRow } from "@cashu/store/investments/signals-screen";
import { localDay, parseServerTime } from "@cashu/ui-logic/core/time";
import {
  type AlertLike,
  alertConditionText,
  alertDistance,
  alertLevelText,
} from "@cashu/ui-logic/investments/v2/logic";
export type SignalFilter = "all" | "positive" | "negative";
/** SQLite stores naive UTC; browser-local Date.parse would hide a fresh undo in Warsaw. */
export function decisionUndoOpen(asOf: string, createdAt: string): boolean {
  return parseServerTime(asOf) - parseServerTime(createdAt) <= 15 * 60_000;
}
export function alertHistoryRows(rows: readonly SignalRow[], asOf: string): SignalRow[] {
  const since = parseServerTime(asOf) - 365 * 86_400_000;
  return rows.filter((row) => row.source === "alert" && parseServerTime(row.firstSeenAt) >= since);
}
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
    if (filter !== "all" && row.polarity !== filter) continue;
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
export const signalDisplayDay = (instant: string | null | undefined): string | null =>
  localDay(instant);

/** Visual geometry only; displayed price facts retain their domain Decimal values. */
export function signalSparkline(closes: readonly { readonly close: unknown }[]): string | null {
  const values = closes.map((point) => Number(String(point.close)));
  if (values.length < 2 || values.some((value) => !Number.isFinite(value))) return null;
  const low = Math.min(...values),
    high = Math.max(...values);
  const span = high - low || 1;
  return values
    .map(
      (value, index) =>
        `${(index / (values.length - 1)) * 100},${24 - ((value - low) / span) * 24}`,
    )
    .join(" ");
}

export type JournalEntry =
  | {
      readonly kind: "year";
      readonly id: string;
      readonly year: string;
      readonly decisions: number;
      readonly signals: number;
      readonly actions: readonly [string, number][];
    }
  | { readonly kind: "month"; readonly id: string; readonly month: string }
  | {
      readonly kind: "decision";
      readonly id: string;
      readonly at: string;
      readonly row: ReadySignals["decisions"][number];
    }
  | { readonly kind: "signal"; readonly id: string; readonly at: string; readonly row: SignalRow };
type JournalRow = Extract<JournalEntry, { kind: "decision" | "signal" }>;

export function journalTimeline(
  decisions: readonly ReadySignals["decisions"][number][],
  signals: readonly SignalRow[],
  filter: "all" | "decisions" | "signals",
): JournalEntry[] {
  const rows: JournalRow[] = [
    ...(filter === "signals"
      ? []
      : decisions.map((row) => ({
          kind: "decision" as const,
          id: row.gid,
          at: row.createdAt,
          row,
        }))),
    ...(filter === "decisions"
      ? []
      : signals.map((row) => ({ kind: "signal" as const, id: row.gid, at: row.firstSeenAt, row }))),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const byYear = new Map<
    string,
    { decisions: number; signals: number; actions: Map<string, number> }
  >();
  for (const row of rows) {
    const year = (signalDisplayDay(row.at) ?? row.at).slice(0, 4);
    const stats = byYear.get(year) ?? {
      decisions: 0,
      signals: 0,
      actions: new Map<string, number>(),
    };
    if (row.kind === "decision") {
      stats.decisions++;
      stats.actions.set(row.row.action, (stats.actions.get(row.row.action) ?? 0) + 1);
    } else stats.signals++;
    byYear.set(year, stats);
  }
  const result: JournalEntry[] = [];
  let lastYear = "",
    lastMonth = "";
  for (const row of rows) {
    const month = (signalDisplayDay(row.at) ?? row.at).slice(0, 7),
      year = month.slice(0, 4);
    if (year !== lastYear) {
      const stats = byYear.get(year);
      if (stats)
        result.push({
          kind: "year",
          id: `y:${year}`,
          year,
          decisions: stats.decisions,
          signals: stats.signals,
          actions: [...stats.actions],
        });
      lastYear = year;
    }
    if (month !== lastMonth) {
      result.push({ kind: "month", id: `m:${month}`, month });
      lastMonth = month;
    }
    result.push(row);
  }
  return result;
}

/** Trigger payloads retain the value even if the alert was later deleted. */
export function alertSignalObserved(row: SignalRow): {
  value: string;
  unit: "price" | "ratio" | "multiple" | "none";
  currency: string | null;
} | null {
  const kind = row.payload.alert_kind;
  const key =
    kind === "change_pct"
      ? "change"
      : kind === "drawdown_from_high"
        ? "drawdown"
        : kind === "weight_above" || kind === "weight_below"
          ? "weight"
          : kind === "volume_spike"
            ? "ratio"
            : kind === "custom"
              ? null
              : "close";
  if (key === null) return null;
  const value = row.payload[key];
  if (typeof value !== "string" && typeof value !== "number") return null;
  const unit =
    kind === "volume_spike"
      ? "multiple"
      : ["change_pct", "drawdown_from_high", "weight_above", "weight_below"].includes(String(kind))
        ? "ratio"
        : "price";
  return {
    value: String(value),
    unit,
    currency: typeof row.payload.currency === "string" ? row.payload.currency : null,
  };
}

export function alertPresentation(row: ReadySignals["alerts"][number]) {
  const source: AlertLike = {
    kind: row.kind,
    scope: row.scope,
    params: { ...row.params },
    polarity: row.polarity,
    severity: row.severity,
    title: row.title,
    status: row.status,
    source: row.source,
    last_value: row.lastValue === null ? null : Number(row.lastValue),
    cooldown_days: row.cooldownDays,
    expires_at: row.expiresAt,
    instrument:
      row.instrumentDetail === null
        ? null
        : {
            label: row.instrumentDetail.name,
            symbol: row.instrumentDetail.symbol,
            currency: row.instrumentDetail.currency,
          },
    state: row.state as AlertLike["state"],
  };
  return {
    condition: alertConditionText(source),
    level: alertLevelText(source),
    distance: alertDistance(source),
  };
}
