// Texts of the loans module's pure helpers (logic.ts) and the fallback loan name (api.ts). See src/i18n.ts.
import { catalog } from "../../i18n.ts";

export const S = catalog({
  /** A percent value: "7,25 %" / "7.25%". */
  pct: { pl: (n: string) => `${n} %`, en: (n: string) => `${n}%` },
  name: { pl: "Podaj nazwę.", en: "Enter a name." },
  principal: { pl: "Podaj kwotę większą od 0.", en: "Enter an amount greater than 0." },
  rate: { pl: "Oprocentowanie od 0 do 100.", en: "Interest rate from 0 to 100." },
  termYears: { pl: "Okres od 1 do 50 lat.", en: "Term from 1 to 50 years." },
  termMonths: { pl: "Okres od 1 do 600 miesięcy.", en: "Term from 1 to 600 months." },
  start: { pl: "Podaj datę pierwszej raty.", en: "Enter the date of the first installment." },
  origination: { pl: "Wypłata nie może być po pierwszej racie.", en: "The disbursement can't be after the first installment." },
  phrase: { pl: (text: string) => `fraza „${text}"`, en: (text: string) => `phrase "${text}"` },
  builtin: { pl: "rozpoznane z wbudowanych fraz", en: "recognized by the built-in phrases" },
  /** A loan without a name or an account (api.ts loanName). */
  loanN: { pl: (n: number) => `Kredyt ${n}`, en: (n: number) => `Loan ${n}` },
});
