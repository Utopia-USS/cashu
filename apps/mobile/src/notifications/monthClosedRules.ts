// When a closed month counts as closed and whether its plan is settled (pure; tested in Node): the
// month-closed screen and the notification planner read the same rules from the same query result.
import { D, type Decimal, type IsoDate } from "@cashu/domain";
import type { CompanionMonthClose } from "@cashu/store/overview/companion";
import { shiftMonth } from "../format/calendar";

export interface MonthClosedState {
  /** The month ended and the base currency has figures in it. */
  readonly complete: boolean;
  /** What the strategy suggests putting away (the suggestion capped at the monthly plan); null without one. */
  readonly planAmount: Decimal | null;
  /** A plan can still be dated in the month after (the running month or later). */
  readonly canPlan: boolean;
  /** No plan is needed (no investing, nothing to plan, too late) or the plan for the month after is saved. */
  readonly planSaved: boolean;
}

/** The parts of the month-close read (`companionQueries().monthClose`) the rules look at. */
export type MonthCloseFacts = Pick<
  CompanionMonthClose,
  "month" | "complete" | "baseCurrency" | "plannedDeposit"
> & {
  readonly currencies: readonly {
    readonly currency: string;
    readonly suggestedTransfer: Decimal;
  }[];
  readonly investing: {
    readonly planned: { readonly amount: Decimal } | null;
    readonly comparison: { readonly suggestedTransfer: Decimal } | null;
  } | null;
};

const positive = (value: Decimal | null | undefined): value is Decimal =>
  value?.gt(D("0")) ?? false;

/** The state of `month` ("YYYY-MM") from its month-close read, on `today`. */
export function monthClosedState(
  close: MonthCloseFacts,
  month: string,
  today: IsoDate,
): MonthClosedState {
  const figures = close.currencies.find((c) => c.currency === close.baseCurrency);
  const investing = close.investing;
  const plan = investing?.planned ?? null;
  const suggested = investing?.comparison?.suggestedTransfer ?? figures?.suggestedTransfer ?? null;
  const planAmount =
    suggested === null
      ? null
      : plan !== null && suggested.gt(plan.amount)
        ? plan.amount
        : suggested;
  // A plan dated in a month long gone is refused by the command: only the running month or later.
  const canPlan = shiftMonth(month, 1) >= today.slice(0, 7);
  const planNeeded = investing !== null && positive(planAmount) && canPlan;
  return {
    complete: close.complete && figures !== undefined && close.month === month,
    planAmount,
    canPlan,
    planSaved: !planNeeded || close.plannedDeposit !== null,
  };
}
