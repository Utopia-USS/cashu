import { D } from "@cashu/domain";
import { normalizeNumberInput } from "@cashu/i18n";
import { createUiLoan } from "@cashu/store/loans/screen";
import { useForm } from "@tanstack/react-form";
import { L } from "./Loans.strings.js";

export const initialLoanForm = (today: string, currency: string) => ({
  name: "",
  type: "mortgage" as "mortgage" | "loan",
  principal: "",
  annualRate: "",
  term: "",
  unit: "years" as "years" | "months",
  startDate: `${today.slice(0, 7)}-01`,
  originationDate: "",
  currency,
});
export type LoanFormValues = ReturnType<typeof initialLoanForm>;

/** Localized form values become the command's canonical Decimal and calendar-date input. */
function canonicalLoanDecimal(text: string) {
  const normalized = normalizeNumberInput(text);
  if (!/^-?\d*\.?\d+$/u.test(normalized)) throw new RangeError("invalid decimal");
  return D(normalized).format("f");
}
export function loanInput(value: LoanFormValues) {
  const term = Number(canonicalLoanDecimal(value.term));
  if (!Number.isInteger(term) || term < 1 || term > (value.unit === "years" ? 50 : 600))
    throw new RangeError("invalid term");
  return {
    name: value.name,
    type: value.type,
    principal: canonicalLoanDecimal(value.principal),
    annualRate: canonicalLoanDecimal(value.annualRate),
    termMonths: term * (value.unit === "years" ? 12 : 1),
    startDate: value.startDate,
    originationDate: value.originationDate || null,
    currency: value.currency,
  };
}
export function useLoanForm(
  today: string,
  currency: string,
  submit: (value: LoanFormValues) => Promise<void>,
) {
  return useForm({
    defaultValues: initialLoanForm(today, currency),
    validators: {
      onSubmit: ({ value }) => {
        try {
          return createUiLoan.input.safeParse(loanInput(value)).success ? undefined : L.invalid;
        } catch {
          return L.invalid;
        }
      },
    },
    onSubmit: ({ value }) => submit(value),
  });
}
