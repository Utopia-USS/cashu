// The emergency cushion form of the "Po zamknięciu miesiąca" tile (the month close's inline form, every field
// kept): opened with the saved settings, validated by cushionPayload, saved through setCushion. Opened in
// incognito, the saved amounts stay out of the form: their fields start empty and an empty one keeps them.
import { setCushion } from "@cashu/store";
import type { budgetDesktopQueries } from "@cashu/store/budget/queries";
import { useCommand } from "@cashu/store-react";
import { cushionPayload } from "@cashu/ui-logic/budget/logic";
import { isIncognito } from "@cashu/ui-logic/core/incognito";
import { useState } from "react";
import { commandFailure, useDurableCommands } from "../../useDurableCommand.js";
import type { CushionFormState } from "./budgetHomeState.js";

type Settings = ReturnType<ReturnType<typeof budgetDesktopQueries>["settings"]["run"]>;
type Draft = CushionFormState["draft"];

export function useCushionForm(args: {
  settings: Settings;
  /** The profile's base currency (the default cushion currency). */
  base: string;
  /** Currencies with data (the currency select shows from two). */
  codes: readonly string[];
}): { form: CushionFormState | null; open: boolean; toggle(): void } {
  const command = useCommand(setCushion);
  const durable = useDurableCommands();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [masked, setMasked] = useState(false);

  const openForm = () => {
    const s = args.settings.settings?.cushion;
    const hide = isIncognito();
    setError(null);
    setMasked(hide);
    setDraft({
      enabled: s?.enabled ?? false,
      mode: s && s.targetAmount === null && s.targetMonths !== null ? "months" : "amount",
      amount: hide ? "" : (s?.targetAmount?.toString() ?? ""),
      months: s?.targetMonths == null ? "6" : String(s.targetMonths),
      currency: s?.currency ?? args.base,
      accountIds: [...(s?.accountIds ?? [])],
      monthlyMax: hide ? "" : (s?.monthlyMax?.toString() ?? ""),
    });
  };
  const save = async () => {
    if (!draft) return;
    const s = args.settings.settings?.cushion;
    const kept = (typed: string, saved: { toString(): string } | null | undefined) =>
      masked && typed.trim() === "" ? (saved?.toString() ?? "") : typed;
    const p = cushionPayload(
      {
        ...draft,
        amount: kept(draft.amount, s?.targetAmount),
        monthlyMax: kept(draft.monthlyMax, s?.monthlyMax),
        accountIds: [],
      },
      args.base,
    );
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
            .map((a) => ({ id: a.gid, name: a.name })),
          masked,
          error,
          busy: command.isPending,
          save,
          cancel: () => setDraft(null),
        }
      : null,
  };
}
