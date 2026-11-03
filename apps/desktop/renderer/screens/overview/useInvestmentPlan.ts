import { D } from "@cashu/domain";
import { normalizeNumberInput } from "@cashu/i18n";
import { cancelPlannedDeposit, createPlannedDeposit } from "@cashu/store";
import type { InvestmentWidgets } from "@cashu/store/overview";
import { useCommand } from "@cashu/store-react";
import { nextDeposit } from "@cashu/ui-logic/investments/logic";
import { useState } from "react";
import { W } from "./OverviewWidgets.strings.js";

export function useInvestmentPlan(investment: InvestmentWidgets, today: string) {
  const create = useCommand(createPlannedDeposit);
  const cancel = useCommand(cancelPlannedDeposit);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(today);
  const [error, setError] = useState<string | null>(null);
  const suggested =
    investment.status === "available"
      ? (investment.monthPlan?.remaining ?? investment.monthPlan?.monthlyAmount ?? null)
      : null;
  const due =
    investment.status === "available"
      ? nextDeposit(today, investment.monthPlan?.dayOfMonth ?? null)
      : today;
  const start = () => {
    if (amount === "") {
      setAmount(suggested?.format("f") ?? "");
      setDate(due);
    }
    setError(null);
  };
  const submit = async () => {
    if (investment.status !== "available" || investment.monthPlan === null) return;
    let parsed: string;
    try {
      const value = D(normalizeNumberInput(amount));
      if (!value.gt(D("0"))) {
        setError(W.invalidPlan);
        return;
      }
      parsed = value.format("f");
    } catch {
      setError(W.invalidPlan);
      return;
    }
    setError(null);
    try {
      const result = await create.run({
        amount: parsed,
        plannedDate: date,
        currency: investment.monthPlan.currency,
        account: null,
        note: null,
      });
      if (!result.ok) {
        setError(W.planRefused);
        return;
      }
      setAmount("");
    } catch {
      setError(W.planRefused);
    }
  };
  const remove = async (gid: string) => {
    if (investment.status !== "available" || !investment.openPlans.some((plan) => plan.gid === gid))
      return;
    try {
      if (!(await cancel.run({ plan: gid })).ok) setError(W.planRefused);
    } catch {
      setError(W.planRefused);
    }
  };
  return {
    amount,
    date,
    error,
    busy: create.isPending || cancel.isPending,
    setAmount,
    setDate,
    start,
    submit,
    remove,
  };
}

export type InvestmentPlanState = ReturnType<typeof useInvestmentPlan>;
