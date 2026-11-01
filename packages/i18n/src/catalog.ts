// Text catalogs: every user-visible text lives in a `*.strings.ts` catalog,
// `catalog({ key: { pl: ..., en: ... } })`. An entry is a string or a function of its params; the compiler
// requires every language in every entry and the same type in each. The catalog resolves the language
// when a key is read, never at import.
import { type Lang, lang } from "./lang.js";

/** The Polish variant fixes an entry's type; every other language must match it. */
type Entries<T> = { [K in keyof T]: { pl: T[K] } & { [L in Exclude<Lang, "pl">]: NoInfer<T[K]> } };

/** Where a catalog keeps its raw `{ pl, en }` entries (non-enumerable): the PL / EN parity guard in
 * tools/arch/src/guards/catalogs.ts reads them by this registered symbol. */
const ENTRIES = Symbol.for("cashu.catalog.entries");

/** A text catalog: `catalog({ save: { pl: "Zapisz", en: "Save" }, n: { pl: (n: number) => ..., en: ... } })`.
 * Reading `S.save` gives the entry in the current language. */
export function catalog<T extends Record<string, unknown>>(
  entries: Entries<T> & Record<string, Record<Lang, unknown>>,
): T {
  const out = {} as T;
  for (const key of Object.keys(entries) as (keyof T & string)[]) {
    Object.defineProperty(out, key, { get: () => entries[key][lang()], enumerable: true });
  }
  Object.defineProperty(out, ENTRIES, { value: entries });
  return out;
}
