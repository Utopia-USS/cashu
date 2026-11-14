// Props of the Investments tab's pure Views (the shell with the review slot and the top tabs, and the
// Portfolio, Signals and Strategy sections). Money arrives as exact `Money`, shares and changes as
// `Decimal` ratios (0.061 = 6.1%) for the value components; texts are finished in the screen hooks.
import type { Decimal, IsoDate, Money } from "@cashu/domain";
import type { LineChartProps, MarkdownBlock, TagTone } from "@cashu/ui/native";
import type { ReactNode } from "react";
import type { TabHeaderProps } from "../../shell/TabHeader";

export type InvestmentsViewName = "portfolio" | "signals" | "strategy";
export const INVESTMENTS_VIEWS: readonly InvestmentsViewName[] = [
  "portfolio",
  "signals",
  "strategy",
];

/** The weekly review slot on top of every view. */
export type ReviewSlot =
  | {
      readonly kind: "due";
      /** The review's name ("Weekly review"). */
      readonly title: string;
      /** "Nov 9 - 15 · 6 cards · due Sunday". */
      readonly meta: string;
      /** One line from the deck: the week's verdict, decisions waiting, ideas. */
      readonly teaser: string | null;
    }
  | {
      readonly kind: "done";
      /** "Next one on Sun, Nov 22" or "2 cards wait on your Mac". */
      readonly sub: string;
      /** Within the undo window of the last save. */
      readonly canUndo: boolean;
    };

export interface InvestmentsViewProps {
  readonly header: Omit<TabHeaderProps, "title" | "right">;
  readonly view: InvestmentsViewName;
  /** Action signals waiting for a decision (the Signals segment's count). */
  readonly signalsCount: number;
  /** Null while the review query is unavailable (privacy, module off, no clock, market or vault
   * identity); a vault without a synced strategy still gets it on the weekly default cadence. */
  readonly review: ReviewSlot | null;
  readonly onViewChanged: (view: InvestmentsViewName) => void;
  readonly onReviewPressed: () => void;
  readonly onReviewUndo: () => unknown;
  /** The current view's section (the route composes it). */
  readonly children?: ReactNode;
}

// ---------------------------------------------------------------------------------------- portfolio

export type AllocationColor = "inv-global" | "inv-pl" | "inv-bonds" | "inv-cash" | "inv-other";

export interface PortfolioPosition {
  readonly gid: string;
  readonly name: string;
  readonly ticker: string;
  /** In the instrument's own currency (quantity x price), else the base value. */
  readonly value: Money;
  readonly weekPct: Decimal | null;
  /** Unrealized result against cost; null for a position valued at cost. */
  readonly resultPct: Decimal | null;
  /** The account(s) holding it. */
  readonly account: string;
  /** An open action signal waits for a decision on it: the red-ringed tile. */
  readonly risk: boolean;
}

export type PortfolioViewProps =
  | {
      readonly status: "unavailable";
      /** Why there is nothing to value yet (no strategy synced, no prices). */
      readonly message: string;
    }
  | {
      readonly status: "ready";
      readonly accounts: {
        readonly options: readonly { readonly gid: string; readonly name: string }[];
        readonly selected: string | null;
        readonly onPicked: (gid: string | null) => void;
      };
      readonly currency: string;
      /** The calendar year of "Added in 2026". */
      readonly yearLabel: string;
      readonly value: {
        readonly total: Money;
        readonly day: { readonly amount: Money; readonly pct: Decimal | null } | null;
        readonly weekPct: Decimal | null;
        /** Positions priced in another currency, each in its own (hidden in incognito). */
        readonly incl: readonly Money[];
        /** The NBP table the conversion used ("Tue, Nov 10"); null without a foreign position. */
        readonly rateDate: string | null;
      };
      readonly chart: LineChartProps;
      readonly facts: {
        readonly thisYear: Decimal | null;
        readonly fromHigh: Decimal | null;
        readonly unrealized: Money;
        readonly added: Money;
        /** The plan to date ("plan to date PLN 27,500"); null without a monthly plan. */
        readonly planToDate: Money | null;
      };
      readonly allocation: {
        readonly rows: readonly {
          readonly key: string;
          readonly label: string;
          readonly now: Decimal;
          readonly target: Decimal | null;
          readonly color: AllocationColor;
        }[];
        readonly drift: { readonly label: string; readonly tone: "warn" | "ok" } | null;
      };
      readonly positions: readonly PortfolioPosition[];
      /** Held positions whose price is older than the strategy allows (a note under the list). */
      readonly pricesStale: number;
      readonly onPositionPressed: (gid: string) => void;
    };

// ------------------------------------------------------------------------------------------ signals

export interface ReadySignalsProps {
  readonly status: "ready";
  /** "New since your review on Sun, Nov 8" / "New in the last week". */
  readonly since: string;
  readonly fired: readonly {
    readonly gid: string;
    readonly title: string;
    readonly sub: string;
    /** Decided rows are not tappable; their sub says the decision. */
    readonly decided: boolean;
    /** The alert is marked "tell this phone": a small bell after the title. */
    readonly marked: boolean;
  }[];
  readonly near: readonly {
    readonly gid: string;
    readonly name: string;
    /** The current public price (shown in incognito too). */
    readonly price: string;
    readonly level: string;
    readonly distance: string;
  }[];
  readonly rules: readonly {
    readonly gid: string;
    readonly message: string;
    readonly sub: string;
    readonly tone: "positive" | "negative" | "neutral";
  }[];
  readonly research: readonly {
    readonly gid: string;
    readonly title: string;
    readonly tag: string;
    readonly tone: TagTone;
    readonly sub: string;
  }[];
  /** The newest research run's day for the tile meta; null without research. */
  readonly researchDay: string | null;
  readonly decisions: readonly {
    readonly gid: string;
    readonly title: string;
    /** "Nov 10" / "10 lis". */
    readonly dateLabel: string;
    readonly reason: string | null;
  }[];
  readonly onAlertPressed: (gid: string) => void;
  readonly onNotePressed: (gid: string) => void;
}

export type SignalsViewProps =
  | { readonly status: "unavailable"; readonly message: string }
  | ReadySignalsProps;

// ----------------------------------------------------------------------------------------- strategy

export interface StrategyViewProps {
  readonly document: {
    readonly blocks: readonly MarkdownBlock[];
    readonly updated: IsoDate;
  } | null;
  readonly rules: readonly {
    readonly id: string;
    readonly name: string;
    readonly kind: string;
    readonly tag: { readonly label: string; readonly tone: "warning" | "positive" };
  }[];
  readonly alertsCount: number;
}
