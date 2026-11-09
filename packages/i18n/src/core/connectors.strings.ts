// Texts of the connector helpers (frontend/src/core/connectors.ts), shared by Settings > Konektory, the connector drawer
// and the bindings. See docs/agents/localization.md.
import { catalog, enCount, plCount } from "../index.js";

type Tone = "pos" | "neg" | "warn" | "info";
type Status = [string, Tone | undefined, boolean];

export const CS = catalog({
  /** The rule behind `Automatyczny zapis` (tooltip, D10). */
  autoRule: {
    pl: "Dopiero po pierwszym zatwierdzonym imporcie i tylko czyste przebiegi (bez ostrzeżeń, same nowe rekordy). Inaczej import czeka na Twoją decyzję.",
    en: "Only after the first approved import and only clean runs (no warnings, only new records). Otherwise the import waits for your decision.",
  },
  kindFailed: {
    pl: (kind: string) => `Konektor nie zadziałał (${kind}).`,
    en: (kind: string) => `The connector failed (${kind}).`,
  },
  neverRun: { pl: "jeszcze nie uruchomiony", en: "not run yet" },
  lastRun: {
    pl: (when: string, outcome: string) => `ostatni przebieg ${when} · ${outcome}`,
    en: (when: string, outcome: string) => `last run ${when} · ${outcome}`,
  },
  bindings: {
    pl: (n: number) => plCount(n, "powiązanie", "powiązania", "powiązań"),
    en: (n: number) => enCount(n, "binding", "bindings"),
  },
  neverSynced: { pl: "jeszcze nie synchronizowano", en: "not synced yet" },
  lastSync: {
    pl: (when: string, status: string) => `ostatnia synchronizacja ${when} · ${status}`,
    en: (when: string, status: string) => `last sync ${when} · ${status}`,
  },
  lastOk: {
    pl: (when: string) => ` · ostatnia udana ${when}`,
    en: (when: string) => ` · last successful ${when}`,
  },
});

/** Status vocabulary (D8): label, tone, solid. */
export const STATUS = catalog({
  pending: { pl: ["do zatwierdzenia", "warn", true] as Status, en: ["to approve", "warn", true] },
  approved: { pl: ["zatwierdzony", "pos", false] as Status, en: ["approved", "pos", false] },
  changed: { pl: ["zmieniony", "neg", true] as Status, en: ["changed", "neg", true] },
  disabled: { pl: ["wyłączony", undefined, false] as Status, en: ["off", undefined, false] },
});

export const OUTCOME = catalog({
  ok: { pl: "ok", en: "ok" },
  failed: { pl: "błąd", en: "error" },
  timeout: { pl: "limit czasu", en: "timeout" },
  refused: { pl: "odmowa", en: "refused" },
});

export const KIND = catalog({
  file: { pl: "plik", en: "file" },
  fetch: { pl: "pobieranie", en: "fetch" },
});

export const MODULE = catalog({
  investments: { pl: "Inwestycje", en: "Investments" },
  budget: { pl: "Budżet", en: "Budget" },
});

/** Short lower-case form of an error kind for table rows. */
export const KIND_SHORT = catalog({
  bad_file: { pl: "odrzucony plik", en: "file rejected" },
  unsupported_version: { pl: "wersja eksportu", en: "export version" },
  auth_failed: { pl: "klucz odrzucony", en: "key rejected" },
  rate_limited: { pl: "limit zapytań", en: "rate limit" },
  network: { pl: "sieć", en: "network" },
  upstream: { pl: "błąd serwisu", en: "service error" },
  internal: { pl: "błąd konektora", en: "connector error" },
  protocol: { pl: "protokół", en: "protocol" },
  timeout: { pl: "limit czasu", en: "timeout" },
  sandbox_unavailable: { pl: "brak piaskownicy", en: "no sandbox" },
  spawn_failed: { pl: "nie uruchomiony", en: "did not start" },
  not_approved: { pl: "niezatwierdzony", en: "not approved" },
  changed: { pl: "zmieniony", en: "changed" },
  interpreter_changed: { pl: "zmieniony interpreter", en: "interpreter changed" },
  disabled: { pl: "wyłączony", en: "off" },
  missing: { pl: "brak katalogu", en: "folder missing" },
  bad_request: { pl: "zły plik", en: "bad file" },
  denied_host: { pl: "host poza listą", en: "host not allowed" },
  forbidden_import: { pl: "niedozwolony import", en: "import not allowed" },
  module_parse_error: { pl: "błąd modułu", en: "module error" },
});
