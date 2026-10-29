// Texts of the budget module's pure helpers (logic.ts). See src/i18n.ts.
import { catalog, enCount, plCount } from "../../i18n.ts";

export const S = catalog({
  /** Short month names, January first. */
  monthsShort: {
    pl: ["sty", "lut", "mar", "kwi", "maj", "cze", "lip", "sie", "wrz", "paź", "lis", "gru"],
    en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  },
  cushionAmount: { pl: "Podaj kwotę większą od zera.", en: "Enter an amount greater than zero." },
  cushionMonths: { pl: "Liczba miesięcy: od 1 do 36.", en: "Number of months: 1 to 36." },
  cushionMax: { pl: "Maks. dopłata: liczba większa od zera albo puste.", en: "Max top-up: a number greater than zero, or empty." },
  autoDetect: { pl: "rozpoznaj automatycznie", en: "detect automatically" },
  typeChecking: { pl: "Konta osobiste", en: "Checking accounts" },
  typeSavings: { pl: "Oszczędności", en: "Savings" },
  typeCredit: { pl: "Karty kredytowe", en: "Credit cards" },
  lastImport: { pl: (d: string) => ` · ostatni import ${d}`, en: (d: string) => ` · last import ${d}` },
  doneAccount: {
    pl: (name: string, tail: string, created: boolean) => `konto ${name}${tail}${created ? " (nowe)" : ""}`,
    en: (name: string, tail: string, created: boolean) => `account ${name}${tail}${created ? " (new)" : ""}`,
  },
  doneDuplicates: {
    pl: (n: number) => plCount(n, "duplikat pominięty", "duplikaty pominięte", "duplikatów pominiętych"),
    en: (n: number) => `${enCount(n, "duplicate", "duplicates")} skipped`,
  },
  doneCategorized: {
    pl: (n: number) => `${n} skategoryzowanych automatycznie`,
    en: (n: number) => `${n} categorized automatically`,
  },
  donePairs: {
    pl: (n: number) => `${plCount(n, "para", "pary", "par")} przelewów`,
    en: (n: number) => enCount(n, "transfer pair", "transfer pairs"),
  },
  syncFailed: { pl: "Synchronizacja nieudana", en: "Sync failed" },
  syncInserted: {
    pl: (n: number) => `Wgrano ${n} nowych transakcji`,
    en: (n: number) => `Loaded ${enCount(n, "new transaction", "new transactions")}`,
  },
  syncPairs: { pl: (n: number) => `, ${n} przelewów wewn.`, en: (n: number) => `, ${enCount(n, "internal transfer", "internal transfers")}` },
  syncSkipped: {
    pl: (n: number) => ` · ${n} konto/a pominięte (limit banku)`,
    en: (n: number) => ` · ${enCount(n, "account", "accounts")} skipped (bank limit)`,
  },
});
