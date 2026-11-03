import { budget, D } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { addCashExpense, deleteCashTransaction } from "@cashu/store";
import { overviewCashWallet } from "@cashu/store/overview";
import { useCommand, useQuery } from "@cashu/store-react";
import { useState } from "react";
import { W } from "./OverviewWidgets.strings.js";

/** Native cash drawer actions stay on the authenticated vault captured by useCommand. */
export function useCashDrawer() {
  const wallet = useQuery(overviewCashWallet, {});
  const add = useCommand(addCashExpense);
  const remove = useCommand(deleteCashTransaction);
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState("groceries");
  const [error, setError] = useState<string | null>(null);
  const categories = budget.CATEGORIES.filter((item) => item.kind === "expense").map((item) => ({
    key: item.key,
    label: budget.categoryLabel(item.key, lang()),
  }));
  const submit = async () => {
    let validAmount = false;
    try {
      validAmount = D(amount).gt(D("0"));
    } catch {
      /* Malformed local form input never reaches the command. */
    }
    if (!validAmount || title.trim() === "") {
      setError(W.invalidCash);
      return;
    }
    setError(null);
    try {
      const result = await add.run({
        amount,
        title: title.trim(),
        category,
        currency: wallet.currency,
      });
      if (!result.ok) {
        setError(W.cashRefused);
        return;
      }
      setAmount("");
      setTitle("");
    } catch {
      setError(W.cashRefused);
    }
  };
  const deleteRow = async (gid: string) => {
    // A stale or cross-vault row cannot be sent from this drawer's current query snapshot.
    if (!wallet.transactions.some((row) => row.gid === gid)) return;
    setError(null);
    try {
      if (!(await remove.run({ txn: gid })).ok) setError(W.cashRefused);
    } catch {
      setError(W.cashRefused);
    }
  };
  return {
    wallet,
    open,
    amount,
    title,
    category,
    categories,
    error,
    busy: add.isPending || remove.isPending,
    setOpen,
    setAmount,
    setTitle,
    setCategory,
    submit,
    deleteRow,
  };
}

export type CashDrawerState = ReturnType<typeof useCashDrawer>;
