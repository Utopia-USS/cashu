import type { CashflowViewProps, PeriodChoice } from "../money-contracts";

export type PeriodPickerProps = Pick<
  CashflowViewProps,
  "period" | "periodBounds" | "onPeriodChange"
> & { readonly testID?: string };
type Bounds = PeriodPickerProps["periodBounds"];
type Kind = PeriodChoice["kind"];

export function isPeriodKind(value: unknown): value is Kind {
  return value === "all" || value === "year" || value === "quarter" || value === "month";
}

function monthIndex(date: string): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

function index(period: Exclude<PeriodChoice, { kind: "all" }>): number {
  if (period.kind === "year") return period.year;
  if (period.kind === "quarter") return period.year * 4 + period.quarter - 1;
  return period.year * 12 + period.month - 1;
}

function fromIndex(kind: Exclude<Kind, "all">, value: number): PeriodChoice {
  if (kind === "year") return { kind, year: value };
  const size = kind === "quarter" ? 4 : 12;
  const year = Math.floor(value / size);
  const part = value - year * size + 1;
  return kind === "quarter" ? { kind, year, quarter: part } : { kind, year, month: part };
}

/** Changing granularity retains the selected period's start, clamped to retained history. */
export function choosePeriodKind(
  kind: Kind,
  period: PeriodChoice,
  bounds: Bounds,
): PeriodChoice | null {
  if (kind === "all") return { kind: "all" };
  if (bounds === null) return null;
  const first = monthIndex(bounds.first);
  const last = monthIndex(bounds.last);
  const anchor =
    period.kind === "all"
      ? last
      : period.year * 12 +
        (period.kind === "month"
          ? period.month - 1
          : period.kind === "quarter"
            ? (period.quarter - 1) * 3
            : 0);
  const selected = Math.max(first, Math.min(last, anchor));
  return fromIndex(
    kind,
    kind === "month" ? selected : Math.floor(selected / (kind === "quarter" ? 3 : 12)),
  );
}

/** Calendar stepping uses indexes, so December and Q4 cross years without timezone arithmetic. */
export function stepPeriod(
  period: PeriodChoice,
  bounds: Bounds,
  direction: -1 | 1,
): PeriodChoice | null {
  if (period.kind === "all" || bounds === null) return null;
  const divisor = period.kind === "month" ? 1 : period.kind === "quarter" ? 3 : 12;
  const first = Math.floor(monthIndex(bounds.first) / divisor);
  const last = Math.floor(monthIndex(bounds.last) / divisor);
  const next = index(period) + direction;
  return next < first || next > last ? null : fromIndex(period.kind, next);
}
