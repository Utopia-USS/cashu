import { catalog } from "@cashu/i18n";

export const S = catalog({
  leftToRepay: { pl: "Zostało do spłaty", en: "Left to repay" },
  leftToRepayBananas: { pl: "Zostało do spłaty, w bananach", en: "Left to repay, in bananas" },
  perYear: { pl: "rocznie", en: "a year" },
  repaidOf: {
    pl: (pct: string, principal: string) => `spłacono ${pct} z ${principal}`,
    en: (pct: string, principal: string) => `${pct} of ${principal} repaid`,
  },
  loan: { pl: "Kredyt", en: "Loan" },
  eachMonth: { pl: "Co miesiąc", en: "Each month" },
  rate: { pl: "Oprocentowanie", en: "Interest rate" },
  lastInstallment: { pl: "Ostatnia rata", en: "Last installment" },
  interestPaid: { pl: "Odsetki zapłacone", en: "Interest paid so far" },
  interestLeft: { pl: "jeszcze", en: "still to pay" },
  nextInstallment: { pl: "Następna rata", en: "Next installment" },
  installment: { pl: "Rata", en: "Installment" },
  ofWhichInterest: { pl: "w tym odsetki", en: "of which interest" },
  fromAccount: {
    pl: (account: string) => `z konta ${account}`,
    en: (account: string) => `from ${account}`,
  },
  balance: { pl: "Saldo kredytu", en: "Loan balance" },
  balanceOverTime: {
    pl: "Saldo kredytu w kolejnych ratach",
    en: "Loan balance over the installments",
  },
  from: { pl: "Od", en: "From" },
  to: { pl: "do", en: "to" },
  noSchedule: { pl: "Brak harmonogramu", en: "No schedule" },
  gone: { pl: "Tego kredytu już nie ma", en: "This loan is no longer here" },
  note: { pl: "Warunki kredytu zmienia się na Macu.", en: "Loan terms are edited on the Mac." },
});
