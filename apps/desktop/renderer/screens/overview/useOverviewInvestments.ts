// The investments half of Przegląd (ab24ab6 modules/investments/v2/Overview.tsx: the hero fact, the Inwestycje
// widget and the Nadwyżka -> wpłata card) in the old JSON shapes: the native portfolio (1y / ytd / 1m), signals and
// review reads through the investments Home adapters, last month's close from the budget queries, and the
// planned deposits of the overview read. Mounted only while the investments module is set up (no conditional hooks).
import type { Decimal } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { C } from "@cashu/i18n/core/common.strings";
import { S } from "@cashu/i18n/investments/v2/Overview.strings";
import { cancelPlannedDeposit, createPlannedDeposit } from "@cashu/store";
import { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { reviewScreenQueries } from "@cashu/store/investments/review-screen";
import { investmentDesktopQueries } from "@cashu/store/investments/screen";
import { signalsQueries } from "@cashu/store/investments/signals-screen";
import type { InvestmentWidgets } from "@cashu/store/overview";
import { useCommand, useQuery } from "@cashu/store-react";
import { useToast } from "@cashu/ui";
import type { MonthClose } from "@cashu/ui-logic/budget/types";
import { dm, money0 } from "@cashu/ui-logic/investments/labels";
import { useState } from "react";
import {
  digestOf,
  openSignalsOf,
  overviewOf,
  performanceOf,
} from "../investments/home/homeAdapters.js";
import { gidOf } from "../investments/home/legacyWire.js";
import { dayReadInstant } from "../signals/signalModels.js";
import { commandFailure, useDurableCommands } from "../useDurableCommand.js";

const portfolio = investmentDesktopQueries();
const signalsQuery = signalsQueries().screen;
const review = reviewScreenQueries().screen;
const budgetQueries = budgetDesktopQueries();

/** "2026-10-05" -> "2026-09" (the last closed month). */
function previousMonth(today: string): string {
  const [y = 0, m = 1] = today.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

const num = (v: Decimal | null | undefined): number | null => (v == null ? null : v.toFloat());

/** A planned deposit as the old `PlannedDeposit` row (`id` = position, `gid` for the commands). */
export interface PlanRow {
  id: number;
  gid: string;
  amount: number;
  currency: string;
  planned_date: string;
  status: "planned" | "booked";
  booked_at: string | null;
}

export function useOverviewInvestments(args: {
  today: string;
  privacy: boolean;
  widgets: InvestmentWidgets;
}) {
  const { today, privacy } = args;
  const language = lang();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const base = { today, timeZone, lang: language, account: null };
  const p1y = useQuery(portfolio.portfolio, { ...base, range: "1y" });
  const pYtd = useQuery(portfolio.portfolio, { ...base, range: "ytd" });
  const p1m = useQuery(portfolio.portfolio, { ...base, range: "1m" });
  const signals = useQuery(signalsQuery, {
    now: dayReadInstant(today),
    today,
    timeZone,
    lang: language,
    privacy,
  });
  const reviewRead = useQuery(review, {
    today,
    lang: language,
    account: null,
    open: false,
    privacy,
  });
  const close = useQuery(budgetQueries.monthClose, {
    today,
    month: previousMonth(today),
    lang: language,
  }).close;

  // Signals first: their legacy numbers follow creation order (as on the investments Home).
  const sig = openSignalsOf(signals);
  const ov = overviewOf(p1y);
  const perf1y = performanceOf(p1y);
  const perfYtd = performanceOf(pYtd);
  const perf1m = performanceOf(p1m);
  const dig = digestOf(reviewRead);
  const monthClose: MonthClose = {
    month: close.month,
    complete: close.complete,
    base_currency: close.baseCurrency,
    first_month: close.firstMonth,
    last_month: close.lastMonth,
    currencies: close.currencies.map((c) => ({
      currency: c.currency,
      income: c.income.toFloat(),
      spending: c.spending.toFloat(),
      surplus: c.surplus.toFloat(),
      cushion_top_up: num(c.cushionTopUp) ?? 0,
      suggested_transfer: num(c.suggestedTransfer) ?? 0,
      transactions: c.transactions,
      income_by_category: [],
      spending_by_category: [],
    })),
    cushion:
      close.cushion === null
        ? null
        : {
            enabled: true,
            currency: close.cushion.currency,
            target: num(close.cushion.target),
            target_source: close.cushion.targetSource,
            target_months: close.cushion.targetMonths,
            average_spending: num(close.cushion.averageSpending),
            balance: close.cushion.balance.toFloat(),
            missing: close.cushion.missing.toFloat(),
            top_up: close.cushion.topUp.toFloat(),
            reached: close.cushion.reached,
            accounts: [],
          },
    investing:
      close.investing === null
        ? null
        : {
            enabled: true,
            strategy_state: close.investing.strategyState,
            planned:
              close.investing.planned === null
                ? null
                : {
                    amount: close.investing.planned.amount.toFloat(),
                    currency: close.investing.planned.currency,
                    day_of_month: close.investing.planned.dayOfMonth,
                  },
            comparison: null,
          },
  };

  // Planned deposits (old usePlannedDeposits): the open plans of the overview read; booked plans are not listed
  // natively (O.md GAP).
  const w = args.widgets.status === "available" ? args.widgets : null;
  const plans: PlanRow[] | null =
    w === null
      ? null
      : w.openPlans.map((p, i) => ({
          id: i + 1,
          gid: p.gid,
          amount: p.amount.toFloat(),
          currency: p.currency,
          planned_date: p.plannedDate,
          status: "planned",
          booked_at: null,
        }));
  const plan =
    w?.monthPlan == null
      ? null
      : {
          monthly_amount: num(w.monthPlan.monthlyAmount),
          covered: w.monthPlan.covered,
          remaining: num(w.monthPlan.remaining),
          currency: w.monthPlan.currency,
        };
  const actions = usePlanActions();
  return { ov, perf1y, perfYtd, perf1m, sig, dig, monthClose, plans, plan, actions };
}

/** Save / undo / change of the month's planned deposit, with toasts (old usePlanActions; also the minimal view's). */
export function usePlanActions() {
  const toast = useToast();
  const create = useCommand(createPlannedDeposit);
  const cancel = useCommand(cancelPlannedDeposit);
  const durable = useDurableCommands();
  const [busy, setBusy] = useState(false);
  const undoPlan = async (gid: string) => {
    const result = await durable.run(`plan-cancel:${gid}`, cancel, { plan: gid });
    if (result.kind === "completed") toast(S.undonePlan, 2500);
    else toast(S.undoFailed(commandFailure(result)), 5000);
  };
  /** `accountId`: a legacy account number or its gid. */
  const save = async (
    amount: number,
    currency: string,
    date: string,
    accountId: number | string | null,
  ) => {
    setBusy(true);
    try {
      const result = await durable.run("plan-create", create, {
        amount: String(amount),
        plannedDate: date,
        currency,
        account: gidOf(accountId),
        note: null,
      });
      if (result.kind !== "completed") {
        toast(S.planSaveFailed(commandFailure(result)), 5000);
        return;
      }
      const gid = (result.value as { plan: string }).plan;
      toast(S.planned(money0(amount, currency), dm(date)), 8000, {
        label: C.undo,
        onClick: () => void undoPlan(gid),
      });
    } finally {
      setBusy(false);
    }
  };
  const drop = async (p: PlanRow) => {
    const result = await durable.run(`plan-cancel:${p.gid}`, cancel, { plan: p.gid });
    if (result.kind !== "completed") toast(S.planChangeFailed(commandFailure(result)), 5000);
  };
  return { save, drop, busy };
}

export type OverviewInvestments = ReturnType<typeof useOverviewInvestments>;
