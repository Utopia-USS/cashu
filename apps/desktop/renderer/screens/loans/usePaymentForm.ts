import { setUiLoanPayment } from "@cashu/store/loans/screen";
import { useForm } from "@tanstack/react-form";
import { L } from "./Loans.strings.js";
export const initialPaymentForm = {
  account: "",
  mode: "text" as "text" | "iban",
  text: "",
  iban: "",
};
export type PaymentFormValues = typeof initialPaymentForm;
export function paymentInput(value: PaymentFormValues, clear = false) {
  return {
    account: value.account,
    ...(value.mode === "text"
      ? { text: clear ? "" : value.text.trim() }
      : { iban: clear ? "" : value.iban.trim() }),
  };
}
export function usePaymentForm(
  submit: (value: PaymentFormValues) => Promise<boolean>,
  defaults: PaymentFormValues = initialPaymentForm,
) {
  return useForm({
    defaultValues: defaults,
    validators: {
      onSubmit: ({ value }) =>
        setUiLoanPayment.input.safeParse(paymentInput(value)).success
          ? undefined
          : L.invalidPayment,
    },
    onSubmit: async ({ value, formApi }) => {
      if (await submit(value)) formApi.setFieldValue("iban", "");
    },
  });
}
