// Removing a bank account from view in the Konta widget: the owner confirms it in a dialog, then the
// widget offers an undo (restore) until the next removal. The account and its history stay in the
// vault (store budget/account-removal.ts).
import { removeBankAccount, restoreBankAccount } from "@cashu/store";
import { useCommand } from "@cashu/store-react";
import { useState } from "react";
import { commandFailure, useDurableCommands } from "../useDurableCommand.js";
import { R } from "./AccountRemoval.strings.js";

export interface RemovalTarget {
  readonly gid: string;
  readonly name: string;
}

export function useAccountRemoval() {
  const removeCommand = useCommand(removeBankAccount);
  const restoreCommand = useCommand(restoreBankAccount);
  const durable = useDurableCommands();
  const [asked, setAsked] = useState<RemovalTarget | null>(null);
  const [undone, setUndone] = useState<RemovalTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const confirm = async () => {
    if (asked === null) return;
    const target = asked;
    try {
      const result = await durable.run(`account-remove:${target.gid}`, removeCommand, {
        account: target.gid,
      });
      if (result.kind !== "completed") {
        setError(commandFailure(result, R.failed));
        return;
      }
      setError(null);
      setUndone(target);
      setAsked(null);
    } catch {
      setError(R.failed);
    }
  };
  const undo = async () => {
    if (undone === null) return;
    try {
      const result = await durable.run(`account-restore:${undone.gid}`, restoreCommand, {
        account: undone.gid,
      });
      if (result.kind === "completed") setUndone(null);
      else setError(commandFailure(result, R.failed));
    } catch {
      setError(R.failed);
    }
  };
  return {
    asked,
    undone,
    error,
    ask: (target: RemovalTarget) => {
      setError(null);
      setAsked(target);
    },
    cancel: () => {
      setError(null);
      setAsked(null);
    },
    confirm,
    undo,
  };
}
