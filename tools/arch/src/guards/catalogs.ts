// Guard: every UI string catalog has the same keys in Polish and English, and plural entries carry
// every plural category the language needs (Intl.PluralRules: pl = one / few / many / other,
// en = one / other). Catalog shape: `{ key: { pl, en } }` where a value is a string, a function
// (same arity in both languages) or a plural object `{ one, few, many, other }`.

export const LANGS = ["pl", "en"] as const;

const PLURAL_KEYS = new Set(["zero", "one", "two", "few", "many", "other"]);

export function pluralCategories(lang: string): string[] {
  return [...new Intl.PluralRules(lang).resolvedOptions().pluralCategories].sort();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPluralObject(v: unknown): v is Record<string, unknown> {
  return (
    isRecord(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => PLURAL_KEYS.has(k))
  );
}

function kindOf(v: unknown): string {
  if (typeof v === "function") return `function/${v.length}`;
  if (isPluralObject(v)) return "plural";
  return typeof v;
}

function checkPlural(where: string, lang: string, value: Record<string, unknown>): string[] {
  const missing = pluralCategories(lang).filter((c) => !(c in value));
  return missing.length
    ? [
        `${where}.${lang}: plural is missing ${missing.join(", ")} (Intl.PluralRules("${lang}") needs ${pluralCategories(lang).join(" / ")})`,
      ]
    : [];
}

/** True when an export looks like a catalog: an object of `{ pl, en }` entries. */
export function isCatalog(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.some((e) => isRecord(e) && LANGS.some((l) => l in e));
}

/** Parity problems of one catalog (empty when it is complete). */
export function catalogProblems(name: string, catalog: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(catalog)) {
    const where = `${name}.${key}`;
    if (!isRecord(entry)) {
      problems.push(`${where}: expected { pl, en }, got ${typeof entry}`);
      continue;
    }
    const keys = Object.keys(entry).sort();
    if (keys.join() !== [...LANGS].sort().join()) {
      problems.push(`${where}: has ${keys.join(", ") || "nothing"}, needs exactly pl and en`);
      continue;
    }
    const kinds = LANGS.map((l) => kindOf(entry[l]));
    if (kinds[0] !== kinds[1]) problems.push(`${where}: pl is ${kinds[0]} but en is ${kinds[1]}`);
    for (const lang of LANGS) {
      const v = entry[lang];
      if (typeof v === "string" && v.trim() === "") problems.push(`${where}.${lang}: empty text`);
      if (isPluralObject(v)) problems.push(...checkPlural(where, lang, v));
    }
  }
  return problems;
}
