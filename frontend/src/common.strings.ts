// Words shared across the whole app (buttons, generic states). Feature texts live in the feature's own
// `*.strings.ts` next to its code; only genuinely generic words belong here. See src/i18n.ts.
import { catalog } from "./i18n.ts";

export const C = catalog({
  save: { pl: "Zapisz", en: "Save" },
  saved: { pl: "Zapisano", en: "Saved" },
  cancel: { pl: "Anuluj", en: "Cancel" },
  close: { pl: "Zamknij", en: "Close" },
  remove: { pl: "Usuń", en: "Delete" },
  edit: { pl: "Edytuj", en: "Edit" },
  add: { pl: "Dodaj", en: "Add" },
  undo: { pl: "Cofnij", en: "Undo" },
  done: { pl: "Gotowe", en: "Done" },
  next: { pl: "Dalej", en: "Next" },
  back: { pl: "Wróć", en: "Back" },
  details: { pl: "Szczegóły", en: "Details" },
  refresh: { pl: "Odśwież", en: "Refresh" },
  retry: { pl: "Spróbuj ponownie", en: "Try again" },
  loading: { pl: "Wczytuję…", en: "Loading…" },
  noData: { pl: "Brak danych", en: "No data" },
  yes: { pl: "Tak", en: "Yes" },
  no: { pl: "Nie", en: "No" },
  /** "Nie udało się: <reason>" */
  failed: { pl: (reason: string) => `Nie udało się: ${reason}`, en: (reason: string) => `Failed: ${reason}` },
});
