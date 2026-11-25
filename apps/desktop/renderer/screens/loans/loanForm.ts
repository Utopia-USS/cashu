// The loan and installment drawers' values (old Drawers.tsx state) and their command inputs.
import { D } from "@cashu/domain";
import { normalizeNumberInput } from "@cashu/i18n";
import { firstOfMonth, type TermUnit } from "@cashu/ui-logic/loans/logic";

export type { TermUnit };

export const initialLoanForm = (today: string, currency: string) => ({
  name: "",
  type: "mortgage" as "mortgage" | "loan",
  principal: "",
  annualRate: "",
  term: "",
  unit: "years" as TermUnit,
  startDate: firstOfMonth(today),
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
    name: value.name.trim(),
    type: value.type,
    principal: canonicalLoanDecimal(value.principal),
    annualRate: canonicalLoanDecimal(value.annualRate),
    termMonths: term * (value.unit === "years" ? 12 : 1),
    startDate: value.startDate,
    originationDate: value.originationDate || null,
    currency: value.currency,
  };
}

export type PaymentMode = "text" | "iban";
export function paymentInput(account: string, mode: PaymentMode, value: string) {
  return { account, ...(mode === "text" ? { text: value } : { iban: value }) };
}
