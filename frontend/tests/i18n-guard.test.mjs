// Guard: user-visible text lives in `*.strings.ts` catalogs (src/i18n.ts), never as a Polish literal in
// code. Heuristic, like the madrosc-tlumu hook: a non-comment line with a Polish letter outside a catalog
// is a hardcoded UI text. Polish without diacritics slips through; reviews catch those.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";

const SRC = new URL("../src/", import.meta.url).pathname;
const POLISH = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/;

/** Files whose Polish is data, not UI copy (path relative to src/ -> reason). */
const ALLOWED = {
  "core/mock.ts": "dev-only mock backend data (VITE_MOCK=1)",
  "core/messages.ts": "Polish labels of backend codes; in English the server's own English text is shown",
  "modules/investments/mock.ts": "dev-only mock backend data",
  "modules/investments/v2/mock.ts": "dev-only mock backend data",
  "modules/investments/v2/research/mock.ts": "dev-only mock backend data",
};

function* files(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(ts|tsx)$/.test(e.name)) yield p;
  }
}

/** `path:line` of every Polish non-comment line in code (not a catalog, not allowed). */
export function hardcodedPolish() {
  const hits = [];
  for (const path of files(SRC)) {
    const rel = relative(SRC, path);
    if (rel.endsWith(".strings.ts") || rel in ALLOWED) continue;
    let inBlock = false;
    readFileSync(path, "utf8").split("\n").forEach((line, i) => {
      const t = line.trim();
      if (inBlock) { if (t.includes("*/")) inBlock = false; return; }
      if (t.startsWith("/*") && !t.includes("*/")) { inBlock = true; return; }
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("{/*")) return;
      const code = t.replace(/\s\/\/\s.*$/, "");
      if (POLISH.test(code)) hits.push(`${rel}:${i + 1}`);
    });
  }
  return hits;
}

test("no hardcoded Polish UI text outside *.strings.ts catalogs", () => {
  const hits = hardcodedPolish();
  assert.deepEqual(hits, [], `Polish text outside a catalog (move it to a *.strings.ts entry):\n${hits.join("\n")}`);
});
