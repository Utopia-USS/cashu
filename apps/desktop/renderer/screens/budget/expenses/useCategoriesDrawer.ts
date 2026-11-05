// Screen hook of the uncategorized merchants drawer (ab24ab6 modules/budget/CategoriesDrawer.tsx): the largest
// totals first in the budget currency, a merchant rule saved at once per choice; rows stay put while it is open.
import { budget } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { S } from "@cashu/i18n/budget/CategoriesDrawer.strings";
import { budgetDesktopQueries, setDesktopMerchantCategory } from "@cashu/store/budget/queries";
import { useCommand, useQuery } from "@cashu/store-react";
import { type SelectOption, useToast, useUiEnv } from "@cashu/ui";
import { cur0s } from "@cashu/ui-logic/core/format";
import { useRef, useState } from "react";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";
import { MASK } from "./expensesModel.js";

const queries = budgetDesktopQueries();

export interface CategoriesDrawerOptions {
  /** The budget currency of the page. */
  currency: string;
  /** `changed`: at least one rule was saved. */
  onClose(changed: boolean): void;
}

export function useCategoriesDrawer({ currency, onClose }: CategoriesDrawerOptions) {
  const { privacy } = useUiEnv();
  const toast = useToast();
  const live = useQuery(queries.uncategorized, { currency });
  const [rows] = useState(live);
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});
  const [error, setError] = useState<string | null>(null);
  const changed = useRef(false);
  const command = useCommand(setDesktopMerchantCategory);
  const durable = useDurableCommands();
  const categories = budget.CATEGORIES.map((c) => ({
    key: c.key,
    label: budget.categoryLabel(c.key, lang()),
    kind: c.kind,
  }));
  const labelOf = (k: string) => categories.find((c) => c.key === k)?.label ?? k;
  const options: SelectOption[] = [
    { value: "", label: S.choose },
    ...categories
      .filter((c) => c.kind === "expense")
      .map((c) => ({ value: c.key, label: c.label })),
    ...categories
      .filter((c) => c.kind !== "expense")
      .map((c) => ({ value: c.key, label: c.label, group: S.income })),
  ];

  const choose = async (merchantKey: string, sample: string, category: string) => {
    if (!category) return;
    setPicked((p) => ({ ...p, [merchantKey]: category }));
    setSaved((s) => ({ ...s, [merchantKey]: false }));
    setError(null);
    const result = await durable.run(`merchant:${merchantKey}`, command, { merchantKey, category });
    if (result.kind !== "completed") {
      setError(S.notSaved(commandFailure(result)));
      return;
    }
    changed.current = true;
    setSaved((s) => ({ ...s, [merchantKey]: true }));
    toast(
      `${privacy ? MASK : sample} → ${labelOf(category)} · ${S.nTransactions(result.value.updated)}`,
      2500,
    );
  };

  return {
    rows: rows.map((r) => {
      const sample = privacy ? MASK : r.sample;
      const key = privacy ? MASK : r.merchantKey;
      return {
        key: r.merchantKey,
        sample,
        sub: r.merchantKey !== r.sample ? key : null,
        title: r.merchantKey !== r.sample ? `${sample}\n${key}` : sample,
        count: String(r.count),
        total: cur0s(r.total.toFloat(), r.currency),
        picked: picked[r.merchantKey] ?? "",
        saved: saved[r.merchantKey] === true,
        choose: (category: string) => void choose(r.merchantKey, r.sample, category),
      };
    }),
    options,
    error,
    busy: command.isPending,
    close: () => onClose(changed.current),
  };
}
export type CategoriesDrawerState = ReturnType<typeof useCategoriesDrawer>;
