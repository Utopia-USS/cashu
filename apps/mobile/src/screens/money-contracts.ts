// Pure screen contracts. Hooks supply exact monetary values and chart display text; Views only
// render them, so the same stories can exercise presentation without a store or navigation.
import type { Decimal, IsoDate, Money } from "@cashu/domain";
import type { DonutProps, DonutSegment, LineChartProps, SwatchColor } from "@cashu/ui/native";
import type { TabHeaderProps } from "../shell/TabHeader";

export type PeriodChoice =
  | { readonly kind: "all" }
  | { readonly kind: "year"; readonly year: number }
  | { readonly kind: "quarter"; readonly year: number; readonly quarter: number }
  | { readonly kind: "month"; readonly year: number; readonly month: number };

export interface PeriodSelection {
  readonly period: PeriodChoice;
  /** First and last retained dates in this currency; the control may step within this span. */
  readonly periodBounds: { readonly first: string; readonly last: string } | null;
  readonly onPeriodChange: (period: PeriodChoice) => void;
}

// --------------------------------------------------------------------------- net worth

export interface NetWorthHero {
  /** `net`: one currency's own net worth; `converted`: every currency at the NBP rate; the View says
   * "in bananas" instead while amounts show on the banana scale. */
  readonly label: "net" | "converted";
  readonly value: Money | null;
  /** Since the previous month end; `pct` is a ratio. */
  readonly change: {
    readonly amount: Money;
    readonly pct: Decimal | null;
    readonly sinceLabel: string;
  } | null;
  /** The other currencies inside a converted total, each in its own currency. */
  readonly parts: readonly { readonly currency: string; readonly amount: Money }[];
  /** The NBP table date of the conversion, display text; null when nothing was converted. */
  readonly rateDate: string | null;
  /** Other currencies shown beside an unconverted figure. */
  readonly otherCurrencies: readonly { readonly currency: string; readonly amount: Money }[];
  /** Currencies without an NBP rate on this device (left out of the figure). */
  readonly missingRate: readonly string[];
}

export interface NetWorthAccountRow {
  readonly gid: string;
  readonly name: string;
  /** The bank's display name; null for cash and manual accounts. */
  readonly bank: string | null;
  readonly amount: Money | null;
  readonly asOf: IsoDate | null;
  readonly type: string;
}

export interface NetWorthLoanRow {
  readonly gid: string;
  readonly name: string;
  readonly outstanding: Money;
  readonly monthly: Money;
  readonly payoffDate: IsoDate;
  /** The repaid share of the principal (0..1), for the meter. */
  readonly share: number;
}

export interface NetWorthAssetRow {
  readonly gid: string;
  readonly name: string;
  readonly kind: "property" | "vehicle" | "other";
  readonly amount: Money;
  readonly asOf: IsoDate;
  /** The valuation is over a year old. */
  readonly stale: boolean;
  /** What a depreciating vehicle loses in the coming month; null without a curve. */
  readonly depreciationPerMonth: Money | null;
}

export interface NetWorthViewProps {
  readonly header: Omit<TabHeaderProps, "title" | "right">;
  /** The base currency the hero, chart and facts are in. */
  readonly currency: string;
  readonly hero: NetWorthHero;
  readonly chart: LineChartProps;
  readonly facts: readonly {
    readonly label: string;
    readonly value: Money | string | null;
    readonly detail?: string;
  }[];
  readonly accounts: readonly NetWorthAccountRow[];
  /** Accounts without a balance, hidden until `showEmpty`. */
  readonly emptyCount: number;
  readonly showEmpty: boolean;
  readonly loans: readonly NetWorthLoanRow[];
  readonly assets: readonly NetWorthAssetRow[];
  /** No investments module (the partner's household profile): Accounts lead, before the hero. */
  readonly partnerFirst: boolean;
  readonly onLoanPressed: (gid: string) => void;
  readonly onShowEmptyToggled: () => void;
}

// --------------------------------------------------------------------------- loan

export interface LoanViewProps {
  /** Null when the loan is gone (removed on the Mac while the page was open). */
  readonly loan: {
    readonly name: string;
    readonly outstanding: Money;
    /** "22% of PLN 500,000 repaid": one sentence (its money already honours privacy). */
    readonly repaidLine: string;
    readonly payoffDate: IsoDate;
    readonly monthly: Money;
    /** The yearly interest rate as a ratio (0.0685 for 6.85%). */
    readonly annualRate: Decimal;
    readonly interestPaid: Money;
    readonly interestRemaining: Money;
    readonly next: {
      readonly date: IsoDate;
      readonly amount: Money;
      readonly interest: Money;
      readonly account: string | null;
    } | null;
    readonly chart: LineChartProps;
  } | null;
}

// --------------------------------------------------------------------------- spending

export type SpendingPeriodKind = "month" | "quarter" | "year";

export interface SpendingRow {
  readonly key: string;
  readonly label: string;
  readonly amount: Money;
  readonly swatch: SwatchColor & DonutSegment["color"];
  /** Share of the period's spending, a ratio. */
  readonly share: Decimal;
  /** Month view only: "+114%" when over the usual amount by more than 10%, `usual` within it; null
   * without a usual amount or outside the month view. */
  readonly vsUsual:
    | { readonly kind: "over"; readonly text: string }
    | { readonly kind: "usual" }
    | null;
}

export interface SpendingViewProps {
  readonly currencies: readonly string[];
  readonly currency: string;
  readonly onCurrencyChange: (currency: string) => void;
  readonly kind: SpendingPeriodKind;
  readonly onKindChange: (kind: SpendingPeriodKind) => void;
  readonly periodLabel: string;
  readonly onPrevious: (() => void) | null;
  readonly onNext: (() => void) | null;
  readonly total: Money;
  /** Month view: spending against the usual so far (current month) or the usual month (past), as
   * signed percent text ("-6.9%"); null otherwise. `over` when above the usual. */
  readonly vsUsual: { readonly text: string; readonly over: boolean } | null;
  readonly chart: DonutProps;
  readonly rows: readonly SpendingRow[];
  readonly empty: boolean;
  /** Spending of the vault's other currencies in this month (the note under the list). */
  readonly otherCurrencies: readonly Money[];
  /** The shown month is complete: its close can be opened ("YYYY-MM"). */
  readonly closedMonth: { readonly month: string; readonly label: string } | null;
  readonly onCategoryPicked: (category: string) => void;
  readonly onMonthClosePressed: (month: string) => void;
}
