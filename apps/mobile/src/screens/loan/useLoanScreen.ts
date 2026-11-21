// One loan's page: what is left, the installment, the rate, the last installment's date, interest paid
// and still to pay, the next installment (and the account it was last paid from, when the loan's
// payment IBAN matched one) and the balance over the schedule. Terms are edited on the Mac.
import { D, type Decimal, type IsoDate, Money } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import { useServices } from "../../services/ServicesProvider";
import type { LoanViewProps } from "../money-contracts";
import { plotRatios } from "../screenContext";
import { type DisplayEnv, moneyText, percentText } from "../today/display";
import { S } from "./Loan.strings";

export function useLoanScreen(args: {
  readonly gid: string;
  readonly today: IsoDate;
}): LoanViewProps {
  const ui = useUiEnv();
  const { locale } = ui;
  const env: DisplayEnv = { locale, privacy: ui.privacy, bananas: ui.bananas ?? null };
  const { moneyQueries } = useServices();
  const today = args.today;
  const rows = useQuery(moneyQueries.loans.screen, { today });
  const schedule = useQuery(moneyQueries.loans.schedule, { loan: args.gid, today });
  const loan = rows.find((row) => row.id === args.gid);
  if (loan === undefined || schedule === null) return { loan: null };
  const currency = loan.currency;
  const money = (amount: Decimal) => new Money(amount, currency);
  const display = (value: Decimal) => formatDecimalValue(value, locale, { currency }).text;
  // The balance before the first installment, then after each one.
  const points = [
    { date: loan.startDate, value: loan.principal },
    ...schedule.rows.map((row) => ({ date: row.date, value: row.balance })),
  ];
  const first = points[0];
  const last = points.at(-1);
  const xIndices = [0, points.length - 1].filter((i, pos, all) => all.indexOf(i) === pos);
  return {
    loan: {
      name: loan.name || S.loan,
      outstanding: money(loan.outstanding),
      repaidLine: S.repaidOf(
        percentText(
          loan.principal.isZero() ? D("0") : D("1").sub(loan.outstanding.div(loan.principal)),
          locale,
          { fractionDigits: 0 },
        ),
        moneyText(loan.principal, currency, env, { fractionDigits: 0 }),
      ),
      payoffDate: loan.payoffDate,
      monthly: money(loan.monthlyPayment),
      annualRate: loan.annualRate.div(D("100")),
      interestPaid: money(loan.paidInterest),
      interestRemaining: money(loan.remainingInterest),
      next:
        schedule.next === null
          ? null
          : {
              date: schedule.next.date,
              amount: money(schedule.next.payment),
              interest: money(schedule.next.interest),
              account: schedule.payingAccount,
            },
      chart: {
        label: S.balanceOverTime,
        valueKind: "amount",
        yFormat: false,
        height: 70,
        series: [
          {
            name: S.balance,
            area: true,
            values: plotRatios(points.map((p) => p.value)),
            accessibleSummary:
              first && last
                ? `${S.from} ${first.date} ${display(first.value)} ${S.to} ${last.date} ${display(last.value)}`
                : S.noSchedule,
          },
        ],
        xLabels: xIndices.map((i) => ({ i, text: points[i]?.date.slice(0, 4) ?? "" })),
        tooltip: (i) => {
          const point = points[i];
          return {
            title: point?.date ?? "",
            rows: point ? [{ name: S.balance, value: display(point.value), amount: true }] : [],
          };
        },
      },
    },
  };
}
