// Texts of the review research block (frontend/src/modules/investments/v2/research/ReviewBlock.tsx). See docs/agents/localization.md.
import { catalog, enForm, plForm } from "../../../index.js";

type Rel = "invalidates" | "weakens" | "fulfills" | "supports";
const PL_REL: Record<Rel, [string, string, string]> = {
  invalidates: ["notatka podważa", "notatki podważają", "notatek podważa"],
  weakens: ["notatka osłabia", "notatki osłabiają", "notatek osłabia"],
  fulfills: ["notatka spełnia", "notatki spełniają", "notatek spełnia"],
  supports: ["notatka wzmacnia", "notatki wzmacniają", "notatek wzmacnia"],
};
const EN_REL: Record<Rel, [string, string]> = {
  invalidates: ["note invalidates", "notes invalidate"],
  weakens: ["note weakens", "notes weaken"],
  fulfills: ["note fulfills", "notes fulfill"],
  supports: ["note supports", "notes support"],
};

export const S = catalog({
  relThesis: {
    pl: (rel: Rel, n: number) => `${n} ${plForm(n, ...PL_REL[rel])} tezę`,
    en: (rel: Rel, n: number) => `${n} ${enForm(n, ...EN_REL[rel])} the thesis`,
  },
  fromSaturday: { pl: "z soboty", en: "from Saturday" },
  fromDate: { pl: (d: string) => `z ${d}`, en: (d: string) => `from ${d}` },
  effect: {
    pl: (weekday: string, rel: string | null, title: string | null) =>
      `research ${weekday}: ${rel ?? "bez zmian"}${title ? ` (${title})` : ""}`,
    en: (weekday: string, rel: string | null, title: string | null) =>
      `research ${weekday}: ${rel ?? "no changes"}${title ? ` (${title})` : ""}`,
  },
});
