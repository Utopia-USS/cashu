// Screen hook of the "Zamknięcie miesiąca" card (ab24ab6 modules/budget/MonthClose.tsx): the native month close of
// this vault in the old figures, the cushion and plan facts, and the inline cushion form on setCushion.
import type { IsoDate } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { S } from "@cashu/i18n/budget/MonthClose.strings";
import { setCushion } from "@cashu/store";
import { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { useCommand, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { cushionPayload, monthLabel, planState, shiftMonth } from "@cashu/ui-logic/budget/logic";
import type { InvestingLink } from "@cashu/ui-logic/budget/types";
import { cur } from "@cashu/ui-logic/core/format";
import { useState } from "react";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";
import type { BudgetCurrency } from "./budgetCurrency.js";
import { E } from "./ExpensesNative.strings.js";
import { MASK } from "./expensesModel.js";

const queries = budgetDesktopQueries();
const TOP = 3;

export interface MonthCloseOptions {
  today: IsoDate;
  /** The budget currency of the page (useBudgetCurrency). */
  bc: BudgetCurrency;
  /** The shown month ("2026-10"); null = the default month. */
  month: string | null;
  onMonth(month: string): void;
}

/** The old cushion form draft with the native account ids. */
interface CushionDraft {
  enabled: boolean;
  mode: "amount" | "months";
  amount: string;
  months: string;
  currency: string;
  accountIds: string[];
  monthlyMax: string;
}

export function useMonthClose({ today, bc, month, onMonth }: MonthCloseOptions) {
  const { privacy } = useUiEnv();
  const loaded = useQuery(queries.monthClose, { today, month, lang: lang() });
  const settings = useQuery(queries.settings);
  const command = useCommand(setCushion);
  const durable = useDurableCommands();
  const [allCats, setAllCats] = useState(false);
  const [draft, setDraft] = useState<CushionDraft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = loaded.close;
  const shown = bc.currency;
  const main = close.currencies.find((c) => c.currency === shown) ?? null;
  const others = close.currencies.filter((c) => c.currency !== shown);
  const spendTotal = main?.spending.toFloat() ?? 0;
  const pct = (a: number) => (spendTotal ? Math.round((a / spendTotal) * 100) : 0);
  const cats = (main?.spendingByCategory ?? []).map((c) => ({
    key: c.category,
    label: c.label,
    amount: cur(c.amount.toFloat(), shown),
    share: `${pct(c.amount.toFloat())}%`,
  }));
  const topUp = main?.cushionTopUp?.toFloat() ?? 0;
  const surplus = main?.surplus.toFloat() ?? 0;

  const c = close.cushion;
  const cushionText = loaded.settingsUnavailable
    ? S.off
    : !c
      ? S.off
      : c.target === null
        ? S.noHistory
        : c.reached
          ? S.reached(cur(c.balance.toFloat(), c.currency))
          : S.progress(
              cur(c.balance.toFloat(), c.currency),
              cur(c.target.toFloat(), c.currency),
              cur(c.topUp.toFloat(), c.currency),
            );

  const inv = close.investing;
  const link: InvestingLink | null = inv
    ? {
        enabled: true,
        strategy_state: inv.strategyState,
        planned: inv.planned
          ? {
              amount: inv.planned.amount.toFloat(),
              currency: inv.planned.currency,
              day_of_month: inv.planned.dayOfMonth,
            }
          : null,
        comparison: inv.comparison
          ? {
              currency: inv.comparison.currency,
              has_data: inv.comparison.hasData,
              surplus: inv.comparison.surplus.toFloat(),
              suggested_transfer: inv.comparison.suggestedTransfer.toFloat(),
              difference: inv.comparison.difference.toFloat(),
              status: inv.comparison.status,
            }
          : null,
      }
    : null;
  const plan = planState(link);
  const planFact: {
    text: string;
    tag: { tone: "positive" | "warning"; text: string } | null;
  } | null = loaded.strategyUnavailable
    ? { text: E.planUnavailable, tag: null }
    : plan.kind === "off"
      ? null
      : plan.kind === "no_plan"
        ? {
            text:
              plan.strategy === "missing"
                ? S.noStrategy
                : plan.strategy === "invalid"
                  ? S.strategyInvalid
                  : S.noContributions,
            tag: null,
          }
        : {
            text: S.perMonth(cur(plan.planned, plan.currency)),
            tag:
              plan.kind === "covered"
                ? {
                    tone: "positive",
                    text: S.covers(
                      plan.difference > 0 ? ` (+${cur(plan.difference, plan.currency)})` : "",
                    ),
                  }
                : {
                    tone: "warning",
                    text: plan.hasData
                      ? S.short(cur(-plan.difference, plan.currency))
                      : S.noData(plan.currency),
                  },
          };

  const base = close.baseCurrency;
  const openForm = () => {
    const s = settings.settings?.cushion;
    setError(null);
    setDraft({
      enabled: s?.enabled ?? false,
      mode: s && s.targetAmount === null && s.targetMonths !== null ? "months" : "amount",
      amount: s?.targetAmount?.toString() ?? "",
      months: s?.targetMonths == null ? "6" : String(s.targetMonths),
      currency: s?.currency ?? base,
      accountIds: [...(s?.accountIds ?? [])],
      monthlyMax: s?.monthlyMax?.toString() ?? "",
    });
  };
  const save = async () => {
    if (!draft) return;
    const p = cushionPayload({ ...draft, accountIds: [] }, base);
    if (!p.ok) {
      setError(p.error);
      return;
    }
    setError(null);
    const result = await durable.run("cushion", command, {
      enabled: p.value.enabled,
      currency: p.value.currency,
      targetAmount: p.value.target_amount,
      targetMonths: p.value.target_months,
      accounts: draft.accountIds,
      monthlyMax: p.value.monthly_max,
    });
    if (result.kind === "completed") setDraft(null);
    else setError(commandFailure(result));
  };

  return {
    month: monthLabel(close.month),
    inProgress: !close.complete,
    prevDisabled: !!close.firstMonth && close.month <= close.firstMonth,
    nextDisabled: !close.lastMonth || close.month >= close.lastMonth,
    step: (delta: -1 | 1) => onMonth(shiftMonth(close.month, delta)),
    noTransactions: main ? null : S.noTransactions(shown),
    figures: main
      ? {
          income: cur(main.income.toFloat(), shown),
          spending: cur(main.spending.toFloat(), shown),
          surplus: cur(surplus, shown),
          surplusNegative: surplus < 0,
          toInvest: cur(main.suggestedTransfer?.toFloat() ?? null, shown),
          toInvestHint: topUp > 0 ? S.afterCushion(cur(topUp, shown)) : S.suggested,
        }
      : null,
    top: cats.slice(0, TOP),
    cats,
    allCats,
    toggleCats: () => setAllCats((v) => !v),
    cushion: cushionText,
    cushionTitle: c && !loaded.settingsUnavailable ? S.cushionLevel : undefined,
    editDisabled: privacy || loaded.settingsUnavailable,
    plan: planFact,
    others: others.length
      ? others.map((o) => `${o.currency} ${cur(o.surplus.toFloat(), o.currency)}`).join(" · ")
      : null,
    form: draft
      ? {
          draft,
          set: (patch: Partial<CushionDraft>) => setDraft({ ...draft, ...patch }),
          currencies: bc.codes.length ? [...bc.codes] : [base],
          accounts: settings.accounts
            .filter((a) => a.currency === draft.currency)
            .map((a) => ({ id: a.gid, name: privacy ? MASK : a.name })),
          error,
          busy: command.isPending,
          save: () => void save(),
          cancel: () => setDraft(null),
        }
      : null,
    toggleForm: () => (draft ? setDraft(null) : openForm()),
  };
}
export type MonthCloseState = ReturnType<typeof useMonthClose>;
