// Pure presentation variants of the loan page, all invented.
import { D, Money } from "@cashu/domain";
import { UiEnvProvider } from "@cashu/ui/native";
import type { ComponentType } from "react";
import type { LoanViewProps } from "../money-contracts";
import { LoanView } from "./LoanView";

const pln = (amount: string) => new Money(D(amount), "PLN");

const mortgage: LoanViewProps = {
  loan: {
    name: "Mortgage",
    outstanding: pln("389600.00"),
    repaidLine: "22% of PLN 500,000 repaid",
    payoffDate: "2049-03-15",
    monthly: pln("2431.18"),
    annualRate: D("0.0685"),
    interestPaid: pln("118400.00"),
    interestRemaining: pln("281300.00"),
    next: {
      date: "2026-11-15",
      amount: pln("2431.18"),
      interest: pln("2224.00"),
      account: "Joint account",
    },
    chart: {
      label: "Loan balance over the installments",
      valueKind: "amount",
      yFormat: false,
      height: 70,
      series: [
        {
          name: "Loan balance",
          area: true,
          values: [1, 0.95, 0.89, 0.82, 0.74, 0.65, 0.54, 0.42, 0.29, 0.15, 0],
          accessibleSummary: "From 2024-04-15 PLN 500,000.00 to 2049-03-15 PLN 0.00",
        },
      ],
      xLabels: [
        { i: 0, text: "2024" },
        { i: 10, text: "2049" },
      ],
    },
  },
};

const privacy = (Story: ComponentType) => (
  <UiEnvProvider locale="en-US" privacy>
    <Story />
  </UiEnvProvider>
);

const meta = { title: "Mobile/Loan", component: LoanView, args: mortgage };
export default meta;

export const Mortgage = { args: mortgage };
export const NoPayingAccount = {
  args: {
    loan: mortgage.loan && {
      ...mortgage.loan,
      next: mortgage.loan.next && { ...mortgage.loan.next, account: null },
    },
  } satisfies LoanViewProps,
};
export const PaidOff = {
  args: {
    loan: mortgage.loan && {
      ...mortgage.loan,
      outstanding: pln("0.00"),
      repaidLine: "100% of PLN 500,000 repaid",
      interestRemaining: pln("0.00"),
      next: null,
    },
  } satisfies LoanViewProps,
};
export const Gone = { args: { loan: null } satisfies LoanViewProps };
export const Incognito = { args: mortgage, decorators: [privacy] };
