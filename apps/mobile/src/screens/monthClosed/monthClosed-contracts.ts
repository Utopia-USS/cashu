// Pure contract of the month-closed View. The hook supplies exact Money and finished copy (money inside
// a sentence already honours privacy); the View only lays it out.
import type { Money } from "@cashu/domain";
import type { TabFresh, TabHeaderProps } from "../../shell/TabHeader";
import type { SyncSlot } from "../../sync/useSyncNotice";

/** Where the screen sits: Today's tab root (the tab header) or pushed from Spending (a native header). */
type MonthClosedChrome =
  | { readonly kind: "tab"; readonly header: Omit<TabHeaderProps, "title" | "right"> }
  | { readonly kind: "pushed"; readonly fresh: TabFresh | null };

/** The strategy tile. */
export type MonthClosedStrategy =
  /** No investments module: the surplus stays on the accounts. */
  | { readonly kind: "off" }
  | {
      readonly kind: "open";
      readonly body: string | null;
      /** The primary button's label ("Plan PLN 2,500"); null when nothing is suggested. */
      readonly planLabel: string | null;
      /** The plan buttons show (the month the plan is for has not passed). */
      readonly canPlan: boolean;
      /** The inline amount field, when "Other amount" opened it. */
      readonly other: { readonly text: string } | null;
      /** Why the last plan was not saved (the tile's one error line); null otherwise. */
      readonly error: string | null;
      readonly pending: boolean;
      readonly onPlan: () => Promise<unknown>;
      readonly onOther: () => void;
      readonly onAmountChange: (text: string) => void;
      readonly onSave: () => Promise<unknown>;
    }
  | {
      readonly kind: "planned";
      readonly body: string | null;
      /** "Planned PLN 2,500 for December." */
      readonly quote: string;
      /** Why Undo did nothing (the deposit is already booked, or the write failed); null otherwise. */
      readonly error: string | null;
      readonly pending: boolean;
      readonly onUndo: () => Promise<unknown>;
    };

export interface MonthClosedRow {
  readonly key: string;
  readonly label: string;
  readonly amount: Money;
  /** "+114%" over the usual by more than 10%, `usual` within it; null without a usual amount. */
  readonly vsUsual:
    | { readonly kind: "over"; readonly text: string }
    | { readonly kind: "usual" }
    | null;
}

export interface MonthClosedViewProps {
  readonly chrome: MonthClosedChrome;
  /** "November closed". */
  readonly title: string;
  /** Today's sync slot under the tab header (a quiet line such as "Sync paused since 19:40"); absent when
   * pushed from Spending. A notice that asks the owner never reaches here: the running month wins then. */
  readonly sync?: SyncSlot;
  readonly hero: {
    /** "Kept in November" (the View appends the bananas suffix while amounts are hidden). */
    readonly label: string;
    /** "savings rate 17%"; null without income. */
    readonly savingsRate: string | null;
    readonly surplus: Money;
    readonly kpis: readonly { readonly label: string; readonly value: Money | string }[];
  };
  readonly strategy: MonthClosedStrategy;
  readonly categories: { readonly title: string; readonly rows: readonly MonthClosedRow[] };
  /** "Show the running month" (Today only); null when pushed. */
  readonly onShowRunning: (() => void) | null;
}
