import { budget, D } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { S as K } from "@cashu/i18n/core/components/CashCard.strings";
import { addCashExpense, deleteCashTransaction } from "@cashu/store";
import { CASH_CURRENCY_MISMATCH } from "@cashu/store/budget/commands";
import { overviewCashWallet } from "@cashu/store/overview";
import { useCommand, useQuery } from "@cashu/store-react";
import { cur } from "@cashu/ui-logic/core/format";
import { useState } from "react";
import { commandFailure, type GuardedOutcome, useDurableCommands } from "../useDurableCommand.js";
import { W } from "./OverviewWidgets.strings.js";

/** The drawer's message for a cash command that did not complete (a refusal named by its code). */
export function cashFailure(result: Exclude<GuardedOutcome<unknown>, { kind: "completed" }>) {
  return commandFailure(
    result,
    result.kind === "refused" && result.reason === CASH_CURRENCY_MISMATCH
      ? W.cashCurrencyMismatch
      : W.cashRefused,
  );
}

/** Native cash drawer actions stay on the authenticated vault captured by useCommand. */
export function useCashDrawer() {
  const wallet = useQuery(overviewCashWallet, {});
  const add = useCommand(addCashExpense);
  const remove = useCommand(deleteCashTransaction);
  const durable = useDurableCommands();
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
      const result = await durable.run("cash-add", add, {
        amount,
        title: title.trim(),
        category,
        currency: wallet.currency,
      });
      if (result.kind !== "completed") {
        setError(cashFailure(result));
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
      const result = await durable.run(`cash-remove:${gid}`, remove, { txn: gid });
      if (result.kind !== "completed") setError(commandFailure(result, W.cashRefused));
    } catch {
      setError(W.cashRefused);
    }
  };
  // Display strings of the old CashCard (formatted here so the drawer View stays pure; masked in privacy mode).
  const c = wallet.currency || "PLN";
  const display = {
    balance: cur(wallet.balance.toFloat(), c),
    negative: wallet.balance.lt(D("0")),
    withdrawnSpent: K.withdrawnSpent(
      cur(wallet.withdrawals.toFloat(), c),
      cur(wallet.expenses.toFloat(), c),
    ),
    rows: wallet.transactions.map((row) => ({
      gid: row.gid,
      date: row.date,
      withdrawal: row.kind === "withdrawal",
      title: row.title ?? "",
      category: row.category ? budget.categoryLabel(row.category, lang()) : "-",
      amount: cur(row.amount.toFloat(), c),
      negative: row.amount.lt(D("0")),
    })),
  };
  return {
    wallet,
    display,
    open,
    amount,
    title,
    category,
    categories,
    error,
    busy: add.isPending || remove.isPending,
    /** The quick add is being saved (the `Dodaj` submit button's spinner). */
    adding: add.isPending,
    setOpen,
    setAmount,
    setTitle,
    setCategory,
    submit,
    deleteRow,
  };
}

export type CashDrawerState = ReturnType<typeof useCashDrawer>;
