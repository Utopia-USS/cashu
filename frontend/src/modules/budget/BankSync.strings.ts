// Texts of the budget's tabbar actions (BankSync.tsx). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../i18n.ts";

export const S = catalog({
  connector: { pl: "Konektor", en: "Connector" },
  view: { pl: "Zobacz", en: "View" },
  syncTitleConnectors: { pl: "Pobierz nowe transakcje z banków (Enable Banking) i konektorów", en: "Fetch new transactions from banks (Enable Banking) and connectors" },
  syncTitleBanks: { pl: "Pobierz nowe transakcje z banków (Enable Banking)", en: "Fetch new transactions from banks (Enable Banking)" },
  syncTitleNone: { pl: "Brak kont bankowych do synchronizacji", en: "No bank accounts to sync" },
  syncing: { pl: "Synchronizuję…", en: "Syncing…" },
  sync: { pl: "↻ Synchronizuj", en: "↻ Sync" },
  imported: { pl: "Zaimportowano", en: "Imported" },
  rejected: { pl: "Odrzucono", en: "Rejected" },
  pendingTitle: { pl: "Import z konektora czeka na zatwierdzenie", en: "An import from a connector is waiting for approval" },
  pending: { pl: (n: number) => `Do zatwierdzenia · ${n}`, en: (n: number) => `To approve · ${n}` },
  importTitle: { pl: "Wyciąg CSV z banku", en: "A CSV statement from the bank" },
  import: { pl: "Import", en: "Import" },
  importedN: {
    pl: (n: number) => `Zaimportowano ${plCount(n, "transakcję", "transakcje", "transakcji")}`,
    en: (n: number) => `Imported ${enCount(n, "transaction", "transactions")}`,
  },
});
