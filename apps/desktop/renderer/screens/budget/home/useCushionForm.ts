// The emergency cushion form of the "Po zamknięciu miesiąca" tile (the month close's inline form, every field
// kept): opened with the saved settings, validated by cushionPayload, saved through setCushion.
import { setCushion } from "@cashu/store";
import type { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { useCommand } from "@cashu/store-react";
import { cushionPayload } from "@cashu/ui-logic/budget/logic";
import { useState } from "react";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";
import { MASK } from "../expenses/expensesModel.js";
import type { CushionFormState } from "./budgetHomeState.js";

type Settings = ReturnType<ReturnType<typeof budgetDesktopQueries>["settings"]["run"]>;
type Draft = CushionFormState["draft"];

export function useCushionForm(args: {
  settings: Settings;
  /** The profile's base currency (the default cushion currency). */
  base: string;
  /** Currencies with data (the currency select shows from two). */
  codes: readonly string[];
  privacy: boolean;
}): { form: CushionFormState | null; open: boolean; toggle(): void } {
  const command = useCommand(setCushion);
  const durable = useDurableCommands();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openForm = () => {
    const s = args.settings.settings?.cushion;
    setError(null);
    setDraft({
      enabled: s?.enabled ?? false,
      mode: s && s.targetAmount === null && s.targetMonths !== null ? "months" : "amount",
      amount: s?.targetAmount?.toString() ?? "",
      months: s?.targetMonths == null ? "6" : String(s.targetMonths),
      currency: s?.currency ?? args.base,
      accountIds: [...(s?.accountIds ?? [])],
      monthlyMax: s?.monthlyMax?.toString() ?? "",
    });
  };
  const save = async () => {
    if (!draft) return;
    const p = cushionPayload({ ...draft, accountIds: [] }, args.base);
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
      accounts: [...draft.accountIds],
      monthlyMax: p.value.monthly_max,
    });
    if (result.kind === "completed") setDraft(null);
    else setError(commandFailure(result));
  };

  return {
    open: draft !== null,
    toggle: () => (draft ? setDraft(null) : openForm()),
    form: draft
      ? {
          draft,
          set: (patch) => setDraft({ ...draft, ...patch }),
          currencies: args.codes.length ? args.codes : [args.base],
          accounts: args.settings.accounts
            .filter((a) => a.currency === draft.currency)
            .map((a) => ({ id: a.gid, name: args.privacy ? MASK : a.name })),
          error,
          busy: command.isPending,
          save: () => void save(),
          cancel: () => setDraft(null),
        }
      : null,
  };
}
