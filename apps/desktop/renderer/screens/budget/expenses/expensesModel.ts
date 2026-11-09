// Pure shaping of the budget's spending (ab24ab6 Expenses.tsx / SpendingDonut.tsx): the donut slices with the
// collapsed "Reszta" slice in the old palette.
import { type Decimal, D as dec } from "@cashu/domain";
import { S as D } from "@cashu/i18n/budget/SpendingDonut.strings";
import type { ChartColor, SpendingSlice } from "@cashu/ui";
import { cur } from "@cashu/ui-logic/core/format";

/** The old 22-colour PALETTE as chart colours (format.ts order). */
const PALETTE: readonly ChartColor[] = Array.from(
  { length: 22 },
  (_, i) => `palette-${i + 1}` as ChartColor,
);

const REST = "__rest__";
const ZERO = dec("0.00");

export interface SpendRow {
  category: string;
  label: string;
  /** Positive magnitude in the one currency. */
  amount: Decimal;
}

/** Legend / ring slices: categories of 1 % or less collapse into "Reszta" when there are two or more. Sums are
 * exact; numbers are only the arcs' sizes and the shares. */
export function spendingSlices(rows: readonly SpendRow[], currency: string) {
  const total = rows.reduce((s, r) => s.add(r.amount), ZERO);
  const pct = (a: Decimal) => (total.isZero() ? 0 : Math.round(a.div(total).toFloat() * 100));
  const slice = (r: SpendRow, color: ChartColor): SpendingSlice => ({
    key: r.category,
    label: r.label,
    value: r.amount.toFloat(),
    amount: cur(r.amount.toFloat(), currency),
    share: `${pct(r.amount)}%`,
    color,
  });
  const small = rows.filter((r) => pct(r.amount) <= 1);
  const big = rows.filter((r) => pct(r.amount) > 1);
  const collapsed = small.length >= 2;
  const shown = collapsed ? big : rows;
  const slices = shown.map((r, i) => slice(r, PALETTE[i % PALETTE.length] ?? "palette-1"));
  if (collapsed) {
    const rest = small.reduce((s, r) => s.add(r.amount), ZERO);
    slices.push({
      ...slice({ category: REST, label: D.rest, amount: rest }, "muted"),
      members: small.map((r) => slice(r, "muted")),
    });
  }
  return { slices, total: cur(total.toFloat(), currency) };
}
