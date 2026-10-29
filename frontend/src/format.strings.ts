// Texts of the shared formatters (src/format.ts). See src/i18n.ts.
import { catalog, enCount, plCount } from "./i18n.ts";

/** Account / asset type -> its group label (format.ts TYPE_LABEL). */
export const TYPE = catalog({
  checking: { pl: "Konta osobiste", en: "Checking accounts" },
  savings: { pl: "Oszczędności", en: "Savings" },
  cash: { pl: "Gotówka", en: "Cash" },
  investment: { pl: "Inwestycje", en: "Investments" },
  property: { pl: "Nieruchomości", en: "Property" },
  vehicle: { pl: "Auto", en: "Car" },
  credit: { pl: "Karty kredytowe", en: "Credit cards" },
  mortgage: { pl: "Hipoteka", en: "Mortgage" },
  loan: { pl: "Pożyczki", en: "Loans" },
  other: { pl: "Inne", en: "Other" },
});

export const S = catalog({
  nAccounts: { pl: (n: number) => plCount(n, "konto", "konta", "kont"), en: (n: number) => enCount(n, "account", "accounts") },
  nModules: { pl: (n: number) => plCount(n, "moduł", "moduły", "modułów"), en: (n: number) => enCount(n, "module", "modules") },
  /** Short weekday names, Sunday first (Date.getDay()). */
  weekdays: {
    pl: ["nd", "pn", "wt", "śr", "czw", "pt", "sob"],
    en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  },
  /** Month names in the genitive ("od września"), January first; English has one form. */
  monthGen: {
    pl: ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"],
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  },
  /** Month names in the nominative ("wrzesień"), January first. */
  monthNom: {
    pl: ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"],
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  },
});
