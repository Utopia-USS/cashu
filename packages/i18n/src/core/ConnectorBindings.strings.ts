// Texts of a connector's fetch bindings (frontend/src/core/ConnectorBindings.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  bindings: {
    pl: (profile: string) => `Powiązania · ${profile}`,
    en: (profile: string) => `Bindings · ${profile}`,
  },
  approveFirst: { pl: "Najpierw zatwierdź konektor", en: "Approve the connector first" },
  bindAccount: { pl: "+ Powiąż konto", en: "+ Bind an account" },
  autoCommit: { pl: "automatyczny zapis", en: "auto save" },
  waitsTitle: {
    pl: "Każdy wynik czeka na Twoje zatwierdzenie",
    en: "Every result waits for your approval",
  },
  toApprove: { pl: "do zatwierdzenia", en: "to approve" },
  afterFirstImport: { pl: "po pierwszym imporcie", en: "after the first import" },
  rateLimitedTitle: {
    pl: "Serwis ograniczył liczbę zapytań",
    en: "The service limited the number of requests",
  },
  apiLimitUntil: {
    pl: (when: string) => `limit API do ${when}`,
    en: (when: string) => `API limit until ${when}`,
  },
  fetching: { pl: "Pobieram…", en: "Fetching…" },
  sync: { pl: "Synchronizuj", en: "Sync" },
  noBindings: {
    pl: "Brak powiązań w tym profilu. Powiąż konto, wpisz klucz, sprawdź połączenie.",
    en: "No bindings in this profile. Bind an account, enter the key, check the connection.",
  },
  bindingsAfterApproval: {
    pl: "Powiązania będą dostępne po zatwierdzeniu.",
    en: "Bindings after approval.",
  },
  required: { pl: "Wymagane.", en: "Required." },
  accountLabel: { pl: "Konto: ", en: "Account: " },
  account: { pl: "Konto", en: "Account" },
  allBound: {
    pl: "Każde konto tego modułu ma już powiązanie.",
    en: "Every account of this module is already bound.",
  },
  clear: { pl: "wyczyść", en: "clear" },
  pasteKey: { pl: "wklej klucz", en: "paste the key" },
  keychainHint: {
    pl: "Zostaje w pęku kluczy macOS; konektor dostaje go tylko na czas uruchomienia.",
    en: "It stays in the macOS keychain; the connector gets it only during a run.",
  },
  autoCommitLabel: { pl: "Automatyczny zapis", en: "Auto save" },
  unbindQ: {
    pl: (account: string) => `Odłączyć ${account}? Usunie sekrety tego powiązania.`,
    en: (account: string) => `Unbind ${account}? This deletes the binding's secrets.`,
  },
  yesUnbind: { pl: "Tak, odłącz", en: "Yes, unbind" },
  unbind: { pl: "Odłącz", en: "Unbind" },
  saving: { pl: "Zapisuję…", en: "Saving…" },
});
