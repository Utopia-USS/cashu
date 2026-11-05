// The cash flow tab's pure parts (ab24ab6 modules/budget/Flows.tsx): the aggregation of the monthly rows into
// quarters or years, the range buttons per aggregation and their defaults.
import { S } from "@cashu/i18n/budget/Flows.strings";

export type Gran = "monthly" | "quarterly" | "yearly";
export interface FlowRow {
  label: string;
  income: number;
  expense: number;
  net: number;
}

/** Window measured in periods of the current granularity: [label, periods] (null = Max). */
export const ranges = (gran: Gran): [string, number | null][] =>
  ({
    monthly: [
      ["6M", 6],
      ["12M", 12],
      ["24M", 24],
      [S.max, null],
    ] as [string, number | null][],
    quarterly: [
      [S.oneYear, 4],
      [S.years(2), 8],
      [S.years(3), 12],
      [S.max, null],
    ] as [string, number | null][],
    yearly: [
      [S.years(3), 3],
      [S.years(5), 5],
      [S.years(10), 10],
      [S.max, null],
    ] as [string, number | null][],
  })[gran];

export const DEFAULT_RANGE: Record<Gran, number | null> = {
  monthly: 12,
  quarterly: 8,
  yearly: null,
};

/** Monthly rows ("2026-03") summed per quarter ("2026 Q1") or year ("2026"). */
export function aggregate(rows: readonly FlowRow[], gran: Gran): FlowRow[] {
  if (gran === "monthly") return [...rows];
  const out = new Map<string, FlowRow>();
  for (const r of rows) {
    const [y, mo] = r.label.split("-").map(Number);
    const key = gran === "yearly" ? `${y}` : `${y} Q${Math.floor(((mo ?? 1) - 1) / 3) + 1}`;
    const cur = out.get(key) ?? { label: key, income: 0, expense: 0, net: 0 };
    cur.income += r.income;
    cur.expense += r.expense;
    cur.net += r.net;
    out.set(key, cur);
  }
  return [...out.values()];
}
