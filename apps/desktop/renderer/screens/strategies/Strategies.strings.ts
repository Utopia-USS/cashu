// Native-only texts of the Strategie tab (the Python texts live in @cashu/i18n/investments/v2/Strategies.strings):
// a host without strategy file access, the task checkbox names of rendered Markdown.
import { catalog } from "@cashu/i18n";
export const S = catalog({
  taskDone: { pl: "Ukończone zadanie", en: "Completed task" },
  taskPending: { pl: "Nieukończone zadanie", en: "Incomplete task" },
  unavailable: {
    pl: "Pliki strategii są niedostępne.",
    en: "Strategy file access is unavailable.",
  },
});
