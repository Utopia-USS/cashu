// Pure shaping of the Wydatki views (ab24ab6 Expenses.tsx / SpendingDonut.tsx): the period label, the donut slices
// with the collapsed "Reszta" slice, the old palette, the drill rows with privacy masking.
import { S as D } from "@cashu/i18n/budget/SpendingDonut.strings";
import type { ChartColor, SpendingSlice } from "@cashu/ui";
import { monthShort } from "@cashu/ui-logic/budget/logic";
import { cur } from "@cashu/ui-logic/core/format";

export type Mode = "month" | "quarter" | "year" | "all";
export interface Period {
  year?: number;
  month?: number;
  quarter?: number;
}

/** The old 22-colour PALETTE as chart colours (format.ts order). */
const PALETTE: readonly ChartColor[] = Array.from(
  { length: 22 },
  (_, i) => `palette-${i + 1}` as ChartColor,
);

const REST = "__rest__";
/** The masked text of names in privacy mode (native behaviour). */
export const MASK = "•••";

export function periodLabel(mode: Mode, period: Period, whole: string): string {
  if (mode === "all") return whole;
  if (mode === "month" && period.month) return `${monthShort(period.month)} ${period.year}`;
  if (mode === "quarter" && period.quarter) return `Q${period.quarter} ${period.year}`;
  if (mode === "year") return `${period.year ?? ""}`;
  return "";
}

export interface SpendRow {
  category: string;
  label: string;
  amount: number;
}

/** Legend / ring slices: categories of 1 % or less collapse into "Reszta" when there are two or more. */
export function spendingSlices(rows: readonly SpendRow[], currency: string) {
  const total = rows.reduce((s, r) => s + r.amount, 0);
  const pct = (a: number) => (total ? Math.round((a / total) * 100) : 0);
  const slice = (r: SpendRow, color: ChartColor): SpendingSlice => ({
    key: r.category,
    label: r.label,
    value: r.amount,
    amount: cur(r.amount, currency),
    share: `${pct(r.amount)}%`,
    color,
  });
  const small = rows.filter((r) => pct(r.amount) <= 1);
  const big = rows.filter((r) => pct(r.amount) > 1);
  const collapsed = small.length >= 2;
  const shown = collapsed ? big : rows;
  const slices = shown.map((r, i) => slice(r, PALETTE[i % PALETTE.length] ?? "palette-1"));
  if (collapsed) {
    const rest = small.reduce((s, r) => s + r.amount, 0);
    slices.push({
      ...slice({ category: REST, label: D.rest, amount: rest }, "muted"),
      members: small.map((r) => slice(r, "muted")),
    });
  }
  return { slices, total: cur(total, currency) };
}
