// Words shared across the whole app (buttons, generic states). Feature texts live in the feature's own
// `*.strings.ts` next to its code; only genuinely generic words belong here. See docs/agents/localization.md.
import { catalog } from "../index.js";

export const C = catalog({
  save: { pl: "Zapisz", en: "Save" },
  saved: { pl: "Zapisano", en: "Saved" },
  cancel: { pl: "Anuluj", en: "Cancel" },
  close: { pl: "Zamknij", en: "Close" },
  remove: { pl: "Usuń", en: "Delete" },
  edit: { pl: "Edytuj", en: "Edit" },
  add: { pl: "Dodaj", en: "Add" },
  undo: { pl: "Cofnij", en: "Undo" },
  next: { pl: "Dalej", en: "Next" },
  details: { pl: "Szczegóły", en: "Details" },
});
