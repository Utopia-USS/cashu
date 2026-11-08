// Pure screen contracts. Hooks supply exact monetary values and chart display text; Views only
// render them, so the same stories can exercise presentation without a store or navigation.
import type { Money } from "@cashu/domain";
import type { BarChartProps, DonutProps, LineChartProps } from "@cashu/ui/native";

export type PeriodChoice =
  | { readonly kind: "all" }
  | { readonly kind: "year"; readonly year: number }
  | { readonly kind: "quarter"; readonly year: number; readonly quarter: number }
  | { readonly kind: "month"; readonly year: number; readonly month: number };

interface CurrencySelection {
  readonly currencies: readonly string[];
  readonly currency: string;
  readonly onCurrencyChange: (currency: string) => void;
}

interface PeriodSelection {
  readonly period: PeriodChoice;
  /** First and last retained dates in this currency; the control may step within this span. */
  readonly periodBounds: { readonly first: string; readonly last: string } | null;
  readonly onPeriodChange: (period: PeriodChoice) => void;
}

export interface MoneyViewProps extends CurrencySelection {
  readonly total: Money | null;
  readonly history: LineChartProps;
  readonly empty: boolean;
  readonly onCashflow: () => void;
  readonly onSpending: () => void;
}

export interface CashflowViewProps extends CurrencySelection, PeriodSelection {
  readonly rows: readonly {
    readonly label: string;
    readonly income: Money;
    readonly expense: Money;
    readonly net: Money;
  }[];
  readonly chart: BarChartProps;
  readonly empty: boolean;
}

export interface SpendingViewProps extends CurrencySelection, PeriodSelection {
  readonly rows: readonly {
    readonly key: string;
    readonly label: string;
    readonly amount: Money;
  }[];
  readonly total: Money;
  readonly chart: DonutProps;
  readonly empty: boolean;
}
