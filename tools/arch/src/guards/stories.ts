// Guard: every component exported by packages/ui and every app View has a Storybook story (CSF,
// `component: Name` in the meta). Stories are the catalog the agent searches before building, the
// render / a11y tests (Vitest addon) and the screenshot baselines (cashu-ui skill, references/storybook.md).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPO_ROOT, readRepoFile } from "../repo.ts";

/** A component name: PascalCase, so SCREAMING_CASE constants (`SPACING_STEPS`) are not components. */
const COMPONENT_NAME = /^[A-Z](?=[A-Z0-9]*[a-z])\w*$/;

/** PascalCase value exports reachable from an index file (follows `export * from` / `export { } from`). */
export function componentExports(indexRel: string, seen = new Set<string>()): string[] {
  if (seen.has(indexRel) || !existsSync(join(REPO_ROOT, indexRel))) return [];
  seen.add(indexRel);
  const source = readRepoFile(indexRel);
  const names = new Set<string>();
  const resolveRel = (spec: string): string => {
    const base = join(dirname(indexRel), spec).replace(/\.js$/, "");
    for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
      if (existsSync(join(REPO_ROOT, base + ext))) return base + ext;
    }
    return `${base}.ts`;
  };
  for (const m of source.matchAll(/export\s+\*\s+from\s+["'](\.[^"']+)["']/g)) {
    for (const n of componentExports(resolveRel(m[1] ?? ""), seen)) names.add(n);
  }
  for (const m of source.matchAll(/export\s+(?!type\b)\{([^}]*)\}/g)) {
    for (const part of (m[1] ?? "").split(",")) {
      const item = part.trim();
      if (!item || item.startsWith("type ")) continue;
      const exported =
        item
          .split(/\s+as\s+/)
          .pop()
          ?.trim() ?? "";
      if (COMPONENT_NAME.test(exported)) names.add(exported);
    }
  }
  for (const m of source.matchAll(/export\s+(?:function|const|class)\s+([A-Z]\w*)/g)) {
    if (m[1] && COMPONENT_NAME.test(m[1])) names.add(m[1]);
  }
  return [...names].sort();
}

/** Component names that some story file declares as its `component`. */
export function storiedComponents(storySources: readonly string[]): Set<string> {
  const names = new Set<string>();
  for (const src of storySources) {
    for (const m of src.matchAll(/\bcomponent\s*:\s*([A-Z]\w*)/g)) if (m[1]) names.add(m[1]);
  }
  return names;
}
