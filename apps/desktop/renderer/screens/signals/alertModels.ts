/** Alert view models: values in their unit, list and history lines, filters and the CSV. */
import { D, type Decimal, Money } from "@cashu/domain";
import type { ReadySignals, SignalRow } from "@cashu/store/investments/signals-screen";
import { csvLine } from "@cashu/ui-logic/core/csv";
import { localDay } from "@cashu/ui-logic/core/time";
import {
  alertHistoryRows,
  alertPresentation,
  alertSignalObserved,
  signalDisplayDay,
} from "./presentation.js";
import { G } from "./Signals.strings.js";

export type AlertRow = ReadySignals["alerts"][number];

/** One number as the value components render it. */
export type ValueDisplay =
  | { readonly kind: "none" }
  | { readonly kind: "ratio"; readonly value: Decimal }
  | { readonly kind: "multiple"; readonly value: Decimal }
  | { readonly kind: "money"; readonly value: Money }
  | { readonly kind: "amount"; readonly value: Decimal; readonly fractionDigits?: number };

/** The alert's last checked value in the unit of its condition. */
export function alertCurrentValue(row: AlertRow): ValueDisplay {
  if (row.lastValue === null) return { kind: "none" };
  const value = D(String(row.lastValue));
  if (row.kind === "volume_spike") return { kind: "multiple", value };
  if (row.unit === "ratio") return { kind: "ratio", value };
  if (row.unit === "price" && row.instrumentDetail !== null)
    return { kind: "money", value: new Money(value, row.instrumentDetail.currency) };
  return { kind: "amount", value, fractionDigits: 2 };
}

/** The value a triggered alert observed, kept in the signal payload after the alert is deleted. */
export function observedValue(row: SignalRow): ValueDisplay {
  const observed = alertSignalObserved(row);
  if (observed === null) return { kind: "none" };
  const value = D(observed.value);
  if (observed.unit === "ratio") return { kind: "ratio", value };
  if (observed.unit === "multiple") return { kind: "multiple", value };
  if (observed.currency) return { kind: "money", value: new Money(value, observed.currency) };
  return { kind: "amount", value };
}

/** One alert as the Alerts page lists it. */
export interface AlertLine {
  readonly gid: string;
  readonly title: string;
  readonly tag: string;
  readonly status: string;
  readonly muted: boolean;
  readonly fromAgent: boolean;
  readonly condition: string;
  /** The instrument symbol, else the scope code (portfolio, bucket). */
  readonly symbol: string | null;
  readonly scope: string;
  readonly polarity: string;
  readonly severity: string;
  readonly level: string | null;
  readonly distance: string | null;
  readonly current: ValueDisplay;
  /** The state of the alert's open signal, else the alert's own state. */
  readonly signalStatus: string;
  readonly stateUnavailable: boolean;
  readonly checkedDay: string | null;
}

export function alertLine(row: AlertRow): AlertLine {
  const shown = alertPresentation(row);
  return {
    gid: row.gid,
    title: row.title,
    tag: shown.tag,
    status: row.status,
    muted: row.status === "muted",
    fromAgent: row.source === "agent",
    condition: shown.condition,
    symbol: row.instrumentDetail?.symbol ?? null,
    scope: row.scope,
    polarity: row.polarity,
    severity: row.severity,
    level: shown.level || null,
    distance: shown.distance === null ? null : shown.distance.text,
    current: alertCurrentValue(row),
    signalStatus: row.signal?.status ?? row.status,
    stateUnavailable: row.stateUnavailable,
    checkedDay: signalDisplayDay(row.lastCheckedAt),
  };
}

/** One triggered alert in the history list. */
export interface HistoryLine {
  readonly gid: string;
  readonly day: string | null;
  readonly message: string;
  readonly value: ValueDisplay;
  readonly status: string;
  readonly decision: string | null;
}

export const historyLine = (row: SignalRow): HistoryLine => ({
  gid: row.gid,
  day: signalDisplayDay(row.firstSeenAt),
  message: row.message,
  value: observedValue(row),
  status: row.status,
  decision: row.decisions.at(-1)?.action || null,
});

/** The alert history of a snapshot (the last year of triggered alerts) as list lines. */
export const alertHistoryLines = (data: ReadySignals): HistoryLine[] =>
  alertHistoryRows(data.signals, data.asOf).map(historyLine);

export type AlertStatusFilter = "all" | "active" | "triggered" | "snoozed" | "muted" | "expired";
export type AlertSourceFilter = "all" | "user" | "agent";
export const ALERT_STATUS_FILTERS: readonly AlertStatusFilter[] = [
  "all",
  "active",
  "triggered",
  "snoozed",
  "muted",
  "expired",
];

export function filterAlerts(
  rows: readonly AlertRow[],
  status: AlertStatusFilter,
  source: AlertSourceFilter,
): AlertRow[] {
  return rows.filter(
    (row) =>
      (status === "all" || row.status === status) && (source === "all" || row.source === source),
  );
}

/** The CSV of the alert history; a deleted alert keeps its row with the deleted label. */
export function historyCsv(history: readonly SignalRow[], alerts: readonly AlertRow[]): string {
  const byAlert = new Map(alerts.map((row) => [row.gid, row]));
  const lines = [
    csvLine([G.csvDate, G.csvTitle, G.csvValue, G.polarity, G.source, G.csvNext, G.csvDecision]),
    ...history.map((row) => {
      const alert = row.alert === null ? null : (byAlert.get(row.alert) ?? null);
      return csvLine([
        localDay(row.firstSeenAt) ?? "",
        alert?.title ?? String(row.payload.title ?? row.instrumentLabel ?? row.message),
        alertSignalObserved(row)?.value ?? "",
        row.polarity,
        alert?.source ?? G.deletedAlert,
        row.status,
        row.decisions.at(-1)?.action ?? "",
      ]);
    }),
  ];
  return `﻿${lines.join("\n")}`;
}
