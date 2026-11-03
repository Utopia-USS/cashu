import { setCushion } from "@cashu/store";
import { useForm } from "@tanstack/react-form";
import { B } from "./Budget.strings.js";

export interface CushionFormValues {
  targetMode: "amount" | "months";
  enabled: boolean;
  currency: string;
  targetAmount: string;
  targetMonths: number | null;
  accounts: string[];
  monthlyMax: string;
}

/** Native form bindings validate the command's schema and submit through the caller's command. */
export function useCushionForm(
  currency: string,
  submit: (value: CushionFormValues) => Promise<void>,
  defaults?: CushionFormValues,
) {
  return useForm({
    defaultValues:
      defaults ??
      ({
        targetMode: "amount",
        enabled: false,
        currency,
        targetAmount: "",
        targetMonths: null,
        accounts: [],
        monthlyMax: "",
      } as CushionFormValues),
    validators: {
      onSubmit: ({ value }) => (setCushion.input.safeParse(value).success ? undefined : B.refused),
    },
    onSubmit: ({ value }) => submit(value),
  });
}
