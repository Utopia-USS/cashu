// The phone's Tailwind sources (packages/ui/src/tokens/native.css). Uniwind compiles a utility for every
// class it finds in a source into the phone's JS bundle, and Metro cannot drop unused ones, so
// native.css names exactly the packages/ui files that `@cashu/ui/native` reaches, never whole folders
// (the desktop renderers and desktop-only components next to the shared ones cost the bundle budget,
// performance.md "Bundles"). A phone file missing from the list would ship without its styles.
import { existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, readRepoFile, stripComments } from "../repo.ts";

const UI_SRC = "packages/ui/src";
const NATIVE_CSS = `${UI_SRC}/tokens/native.css`;

/** The module file a relative specifier names, as Metro resolves it for the phone (`.native` first). */
function resolveModule(fromFile: string, specifier: string): string {
  const base = join(dirname(fromFile), specifier).replace(/\.js$/, "");
  for (const ext of [".native.tsx", ".native.ts", ".tsx", ".ts"]) {
    if (existsSync(join(REPO_ROOT, base + ext))) return base + ext;
  }
  throw new Error(`${fromFile}: cannot resolve ${specifier}`);
}

/** Every packages/ui file reachable from the phone's entry through relative imports and re-exports. */
function phoneFiles(): Set<string> {
  const seen = new Set<string>();
  const queue = [`${UI_SRC}/native.ts`];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const m of stripComments(readRepoFile(file)).matchAll(/\bfrom\s+"(\.{1,2}\/[^"]+)"/g)) {
      queue.push(resolveModule(file, m[1] as string));
    }
  }
  return seen;
}

/** The packages/ui files native.css lists as `@source`. */
function cssSources(): Set<string> {
  const out = new Set<string>();
  for (const m of readRepoFile(NATIVE_CSS).matchAll(/^@source\s+"([^"]+)";/gm)) {
    const path = relative(REPO_ROOT, join(REPO_ROOT, dirname(NATIVE_CSS), m[1] as string));
    if (path.startsWith(`${UI_SRC}/`)) out.add(path);
  }
  return out;
}

describe("guard: the phone's Tailwind sources are exactly the files it renders", () => {
  const phone = phoneFiles();
  const listed = cssSources();

  it("lists every packages/ui file @cashu/ui/native reaches", () => {
    expect(
      [...phone].filter((f) => !listed.has(f)).sort(),
      `add these as @source lines to ${NATIVE_CSS}, or Uniwind generates no styles for them`,
    ).toEqual([]);
  });

  it("lists no file the phone does not render (folders and desktop files grow the bundle)", () => {
    expect(
      [...listed].filter((f) => !phone.has(f)).sort(),
      `remove these @source lines from ${NATIVE_CSS}`,
    ).toEqual([]);
  });
});
