// Removing a bank account from view in the Konta widget (store budget/account-removal.ts).
import { catalog } from "@cashu/i18n";

export const R = catalog({
  remove: { pl: "Usuń", en: "Remove" },
  removeTitle: {
    pl: (name: string) => `Usuń konto ${name} z widoku`,
    en: (name: string) => `Remove account ${name} from view`,
  },
  confirmTitle: { pl: "Usunąć konto z widoku?", en: "Remove the account from view?" },
  confirmText: {
    pl: (name: string) =>
      `${name} zniknie z Przeglądu, list kont i majątku netto, a import do niego zostanie wstrzymany. Jego transakcje wypadną z budżetu (wydatki, przychody, przepływy, subskrypcje); przelewy między nim a Twoimi kontami nadal liczą się jako przelewy własne. Po przywróceniu konta historia wraca.`,
    en: (name: string) =>
      `${name} leaves the overview, the account lists and net worth, and imports into it stop. Its transactions leave the budget (spending, income, cash flow, subscriptions); transfers between it and your accounts still count as own transfers. Restoring the account brings its history back.`,
  },
  confirm: { pl: "Usuń z widoku", en: "Remove from view" },
  cancel: { pl: "Anuluj", en: "Cancel" },
  removed: {
    pl: (name: string) => `Usunięto konto ${name} z widoku.`,
    en: (name: string) => `Removed account ${name} from view.`,
  },
  undo: { pl: "Cofnij", en: "Undo" },
  failed: { pl: "Nie udało się usunąć konta.", en: "Could not remove the account." },
});
