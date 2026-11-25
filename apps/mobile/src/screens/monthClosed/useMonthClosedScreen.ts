// The month-closed state of one closed month: what it kept (the surplus of the base currency, the
// savings rate, income, spending and the cushion in months of spending), what the synced strategy
// says about the surplus with the plan for the month after it (`createPlannedDeposit`, undone with
// `cancelPlannedDeposit`) and where the month went against a usual one. Shown on Today in the first
// days of a month and pushed from Spending's "{Month} closed" link.
import { D, type Decimal, daysInMonth, type IsoDate, Money } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { cancelPlannedDeposit, createPlannedDeposit } from "@cashu/store/investments/planned";
import { type CommandOutcome, useCommand, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { useState } from "react";
import { monthClosedState } from "../../notifications/monthClosedRules";
import { useServices } from "../../services/ServicesProvider";
import { useTabChrome } from "../../shell/useTabChrome";
import { type DisplayEnv, moneyText, monthName, percentText, shiftMonth } from "../today/display";
import { S } from "./MonthClosed.strings";
import type {
  MonthClosedRow,
  MonthClosedStrategy,
  MonthClosedViewProps,
} from "./monthClosed-contracts";

/** The tile's error line for a plan or Undo that did not go through; null when it did. */
function refusalText(outcome: CommandOutcome<unknown>): string | null {
  if (outcome.kind === "completed") return null;
  if (outcome.kind !== "refused") return S.couldNotSave;
  switch (outcome.reason) {
    case "amount_not_positive":
    case "amount_not_number":
      return S.amountError;
    case "amount_too_large":
      return S.amountTooLarge;
    case "planned_booked":
      return S.alreadyBooked;
    default:
      return S.couldNotSave;
  }
}

/** A category is over its usual amount above this factor. */
const OVER_USUAL = D("1.1");

export interface MonthClosedScreen {
  readonly view: MonthClosedViewProps;
  /** The month ended and the base currency has figures in it. */
  readonly complete: boolean;
  /** No plan is needed (no investing, nothing to plan) or the plan for the month after is saved. */
  readonly planSaved: boolean;
}

/** "Dec 1 06:40" / "1 gru 06:40": when the newest bank data arrived, in the device timezone. */
/** The plan's date in "YYYY-MM": its day of the month (clamped to the month), else the 1st. */
function planDate(month: string, dayOfMonth: number | null): IsoDate {
  const days = daysInMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7)));
  const day = Math.min(Math.max(dayOfMonth ?? 1, 1), days);
  return `${month}-${String(day).padStart(2, "0")}`;
}

const positive = (value: Decimal | null | undefined): value is Decimal =>
  value?.gt(D("0")) ?? false;

export function useMonthClosedScreen(args: {
  readonly today: IsoDate;
  /** The closed month, "YYYY-MM". */
  readonly month: string;
  readonly chrome: "tab" | "pushed";
  readonly openProfile: () => void;
  /** "Show the running month" (Today only); null when pushed. */
  readonly onShowRunning: (() => void) | null;
}): MonthClosedScreen {
  const ui = useUiEnv();
  const env: DisplayEnv = { locale: ui.locale, privacy: ui.privacy, bananas: ui.bananas ?? null };
  const lang = ui.locale.toLowerCase().startsWith("pl") ? "pl" : "en";
  const { moneyQueries } = useServices();
  const header = useTabChrome({ fresh: "bank", openProfile: args.openProfile });
  const close = useQuery(moneyQueries.companion.monthClose, {
    today: args.today,
    month: args.month,
    lang,
  });
  const base = close.baseCurrency;
  const month = useQuery(moneyQueries.companion.month, {
    today: args.today,
    currency: base,
    month: args.month,
    lang,
  });
  const create = useCommand(createPlannedDeposit);
  const cancel = useCommand(cancelPlannedDeposit);
  const [otherText, setOtherText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const closed = monthName(args.month, ui.locale);
  const following = shiftMonth(args.month, 1);
  const followingName = monthName(following, ui.locale);
  const figures = close.currencies.find((c) => c.currency === base);
  const zero = D("0.00");
  const income = figures?.income ?? zero;
  const surplus = figures?.surplus ?? zero;
  const money = (value: Decimal) => moneyText(value, base, env, { fractionDigits: 0 });

  // Cushion: its balance in months of the average spending, when the cushion is set up.
  const cushion = close.cushion;
  const cushionMonths =
    cushion !== null && positive(cushion.averageSpending)
      ? cushion.balance.div(cushion.averageSpending)
      : null;

  // The ordinary bank-data line: a batch time is when the data arrived, not when the month closed.
  const freshLine = header.fresh;

  // The strategy tile: what the surplus is for, the plan for the month after.
  const investing = close.investing;
  const plan = investing?.planned ?? null;
  const rules = monthClosedState(close, args.month, args.today);
  const { planAmount, canPlan } = rules;
  const sentences: string[] = [];
  if (cushion?.topUp.gt(D("0"))) {
    sentences.push(S.cushionShortTopUp(money(cushion.topUp)));
    if (plan !== null) sentences.push(S.monthlyPlan(money(plan.amount)));
  } else if (plan !== null) {
    sentences.push(
      cushion !== null ? S.cushionFullPlan(money(plan.amount)) : S.monthlyPlan(money(plan.amount)),
    );
  } else if (cushion !== null) {
    sentences.push(S.cushionFull);
  }
  const body = sentences.length === 0 ? null : sentences.join(" ");
  const save = async (amount: string) => {
    const outcome = await create.run({
      amount,
      plannedDate: planDate(following, plan?.dayOfMonth ?? null),
      currency: base,
      account: null,
      note: null,
    });
    setError(refusalText(outcome));
    if (outcome.kind === "completed") setOtherText(null);
    return outcome;
  };
  const undo = async (plan: string) => {
    const outcome = await cancel.run({ plan });
    setError(refusalText(outcome));
    return outcome;
  };
  const deposit = close.plannedDeposit;
  const strategy: MonthClosedStrategy =
    investing === null
      ? { kind: "off" }
      : deposit !== null
        ? {
            kind: "planned",
            body,
            quote: S.planned(
              moneyText(deposit.amount, deposit.currency, env, { fractionDigits: 0 }),
              followingName,
            ),
            error,
            pending: cancel.isPending,
            onUndo: () => undo(deposit.gid),
          }
        : {
            kind: "open",
            body,
            planLabel: positive(planAmount) ? S.plan(money(planAmount)) : null,
            canPlan,
            other: otherText === null ? null : { text: otherText },
            error,
            pending: create.isPending,
            onPlan: () => (positive(planAmount) ? save(planAmount.format("f")) : Promise.resolve()),
            onOther: () => {
              setError(null);
              setOtherText("");
            },
            onAmountChange: (text) => {
              setError(null);
              setOtherText(text);
            },
            onSave: () => save((otherText ?? "").trim()),
          };

  const percent = (ratio: Decimal) =>
    formatDecimalValue(ratio, ui.locale, { percent: true, fractionDigits: 0, signed: true }).text;
  const rows: MonthClosedRow[] = month.categories.map((c) => ({
    key: c.category,
    label: c.label,
    amount: new Money(c.amount, base),
    vsUsual:
      c.usual === null || c.usual.isZero()
        ? null
        : c.amount.gt(c.usual.mul(OVER_USUAL))
          ? { kind: "over", text: percent(c.amount.sub(c.usual).div(c.usual)) }
          : { kind: "usual" },
  }));

  const view: MonthClosedViewProps = {
    chrome:
      args.chrome === "tab"
        ? { kind: "tab", header: { ...header, fresh: freshLine } }
        : { kind: "pushed", fresh: freshLine },
    title: S.monthClosed(closed),
    hero: {
      label: S.keptIn(closed),
      savingsRate: positive(income)
        ? S.savingsRate(percentText(surplus.div(income), ui.locale))
        : null,
      surplus: new Money(surplus, base),
      kpis: [
        { label: S.income, value: new Money(income, base) },
        { label: S.spent, value: new Money(figures?.spending ?? zero, base) },
        ...(cushionMonths === null
          ? []
          : [
              {
                label: S.cushion,
                value: S.months(
                  formatDecimalValue(cushionMonths, ui.locale, { fractionDigits: 1 }).text,
                ),
              },
            ]),
      ],
    },
    strategy,
    categories: { title: S.whereMonthWent(closed), rows },
    onShowRunning: args.onShowRunning,
  };
  return { view, complete: rules.complete, planSaved: rules.planSaved };
}

/** The month before today's: the one Today's month-closed state is about. */
export function lastClosedMonth(today: IsoDate): string {
  return shiftMonth(today.slice(0, 7), -1);
}
