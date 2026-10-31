// Texts of the spending donut (SpendingDonut.tsx). See docs/agents/localization.md.
import { catalog } from "../index.js";

export const S = catalog({
  /** The slice that collects the categories of 1% or less. */
  rest: { pl: "Reszta", en: "Other" },
  total: { pl: "Suma wydatków", en: "Total expenses" },
});
