// Guard: user-visible text lives in `*.strings.ts` / `strings.ts` catalogs (PL + EN), never as a Polish literal
// in UI code. A heuristic, ported from frontend/tests/i18n-guard.test.mjs: a non-comment line with a Polish
// letter outside a catalog is a hardcoded UI text. Polish without diacritics slips through; reviews catch those.
// Matching data (CSV headers, keyword rules, LLM prompts) is Polish on purpose and lives in packages/domain,
// which this guard does not scan.

const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

/** 1-based numbers of the lines of `src` that carry a Polish letter outside a comment. */
export function polishCodeLines(src: string): number[] {
  const hits: number[] = [];
  let inBlock = false;
  src.split("\n").forEach((line, i) => {
    const t = line.trim();
    if (inBlock) {
      if (t.includes("*/")) inBlock = false;
      return;
    }
    if (t.startsWith("/*") && !t.includes("*/")) {
      inBlock = true;
      return;
    }
    if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*"))
      return;
    const code = t.replace(/\s\/\/\s.*$/, "");
    if (POLISH.test(code)) hits.push(i + 1);
  });
  return hits;
}
