// Pure contract of the Today View. The hook supplies exact Money and finished copy (money inside a
// sentence already honours privacy); the View only lays it out. The month-closed state takes Today's
// place in the first days of a month (`showsClosed`).
import type { IsoDate, Money } from "@cashu/domain";
import type { IconName, SwatchColor } from "@cashu/ui/native";
import type { TabHeaderProps } from "../../shell/TabHeader";
import type { MonthClosedViewProps } from "../monthClosed/monthClosed-contracts";

/** One "Worth a look" row. */
export interface TodayAttentionRow {
  readonly key: string;
  readonly icon: IconName;
  readonly tone: "warn" | "neg" | "default";
  readonly title: string;
  readonly sub: string;
  /** "31%", "PLN 400", "+PLN 132". */
  readonly magnitude: string;
  /** "of spending", "short", "a year". */
  readonly magnitudeLabel: string;
  readonly onPress: (() => void) | null;
}

interface TodayUpcomingRow {
  readonly key: string;
  readonly date: IsoDate;
  readonly payee: string;
  readonly amount: Money;
  /** The paying account's name; null when unknown. */
  readonly account: string | null;
  /** The account's balance covers it; null when unknown. */
  readonly covered: boolean | null;
}

interface TodaySpentRow {
  readonly category: string;
  readonly label: string;
  readonly amount: Money;
  /** Share of the largest category (the meter). */
  readonly share: number;
  readonly swatch: SwatchColor;
}

export interface TodayReady {
  readonly kind: "ready";
  readonly header: Omit<TabHeaderProps, "title" | "right">;
  /** The month's name: "November", "Listopad". */
  readonly title: string;
  readonly banner: {
    readonly tone: "warning";
    readonly title: string;
    readonly body: string;
  } | null;
  /** The bank data is stale: the hero tile fades. */
  readonly stale: boolean;
  readonly hero: {
    readonly label: string;
    readonly daysLeftLabel: string;
    readonly keep: Money;
    readonly negative: boolean;
    readonly subLine: string;
    readonly pace: {
      readonly spentShare: number;
      readonly usualShare: number;
      readonly left: string;
      readonly right: string;
      readonly rightTone: "default" | "positive";
    } | null;
    readonly kpis: readonly { readonly label: string; readonly value: Money }[];
  };
  /** At most 3; empty: no tile. */
  readonly attention: readonly TodayAttentionRow[];
  /** The next 7 days. */
  readonly upcoming: readonly TodayUpcomingRow[];
  /** Their sum in the month's currency; null when none is in it. */
  readonly total: Money | null;
  readonly spent: {
    readonly rows: readonly TodaySpentRow[];
    readonly more: { readonly count: number; readonly amount: Money } | null;
  };
  /** The quiet "small payments without a category" line; null when none or a tier-1 row says it. */
  readonly uncategorized: { readonly count: number; readonly sum: Money } | null;
  /** The laptop note under the tiles. */
  readonly note: string;
  readonly onHeroPressed: () => void;
  readonly onSpentPressed: () => void;
  readonly onUncategorizedPressed: () => void;
}

export type TodayState =
  | ({ readonly kind: "closed"; readonly month: string } & MonthClosedViewProps)
  | TodayReady;
