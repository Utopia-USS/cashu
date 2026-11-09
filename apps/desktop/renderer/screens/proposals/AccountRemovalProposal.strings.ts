// The proposal drawer's texts for an account removal (MCP propose_account_removal).
import { catalog } from "@cashu/i18n";

export const A = catalog({
  kind: { pl: "usunięcie konta", en: "account removal" },
  approve: { pl: "Usuń konto z widoku", en: "Remove account from view" },
  account: { pl: "Konto", en: "Account" },
  effectLabel: { pl: "Po zatwierdzeniu", en: "On approval" },
  effect: {
    pl: "Konto zniknie z Przeglądu, list kont i majątku netto, a import do niego zostanie wstrzymany. Jego transakcje wypadną z budżetu (wydatki, przychody, przepływy, subskrypcje); przelewy między nim a Twoimi kontami nadal liczą się jako przelewy własne. Po przywróceniu konta historia wraca.",
    en: "The account leaves the overview, the account lists and net worth, and imports into it stop. Its transactions leave the budget (spending, income, cash flow, subscriptions); transfers between it and your accounts still count as own transfers. Restoring the account brings its history back.",
  },
});
