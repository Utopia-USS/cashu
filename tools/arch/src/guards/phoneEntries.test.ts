// The phone-safe store entries the mobile app imports stay off the desktop-only import pipeline and the
// proposal modules. Metro bundles whole files and the phone does not tree-shake, so one re-export from a
// barrel drags the whole pipeline in (the importing barrel alone was 124 kB); `bundle:check` has too much
// headroom to notice. The walk follows value imports (not `import type`) through relative paths and the
// exports maps of @cashu/store and @cashu/domain; other packages are not followed.
import { existsSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, readRepoFile, stripComments, workspacePackages } from "../repo.ts";

/** The phone-safe entries of @cashu/store the mobile app imports. */
const PHONE_ENTRIES = [
  "./investments/screen",
  "./investments/signals-screen",
  "./investments/review-screen",
  "./investments/research-screen",
  "./investments/commands",
  "./investments/prices",
  "./budget/companion",
  "./overview/companion",
] as const;

/** Desktop-only modules a phone entry must never reach. */
const FORBIDDEN_FILES = new Set([
  "packages/domain/src/investments/importing/index.ts",
  "packages/domain/src/investments/importing/csvMapping.ts",
  "packages/store/src/investments/queries/import-preview.ts",
]);
const PROPOSAL_FILE = /\/proposal[^/]*\.tsx?$/u;
/**
 * Proposal files a phone entry may reach: the core store module's own. The phone opens every vault with
 * `builtinModules()` (reached here through `overview/networth.ts` -> `modules.ts` -> `core/index.ts`),
 * so they are in the bundle regardless; `review-screen` also reaches `proposal-execution.ts` through
 * `desktop-review/decide.ts`. The investments proposal services (`investments/services/proposal*`,
 * built on the import pipeline) stay banned.
 */
const ALLOWED_PROPOSAL_FILES = new Set([
  "packages/store/src/core/proposals.ts",
  "packages/store/src/core/proposal-commands.ts",
  "packages/store/src/core/proposal-execution.ts",
  "packages/store/src/core/proposal-service.ts",
]);

/** Exports maps of the packages the walk follows, by package name. */
const FOLLOWED = new Map(
  workspacePackages()
    .filter((p) => p.manifest.name === "@cashu/store" || p.manifest.name === "@cashu/domain")
    .map((p) => [p.manifest.name as string, p] as const),
);

function exportTarget(name: string, subpath: string): string | null {
  const pkg = FOLLOWED.get(name);
  const target = (pkg?.manifest.exports as Record<string, unknown> | undefined)?.[subpath];
  if (pkg === undefined || typeof target !== "string") return null;
  return normalize(join(pkg.dir, target));
}

/** A relative specifier as written (`./x.js`, `../y`) to the repo file it names. */
function resolveRelative(from: string, specifier: string): string | null {
  const base = normalize(join(dirname(from), specifier));
  const stem = base.replace(/\.(js|ts|tsx)$/u, "");
  for (const candidate of [
    `${stem}.ts`,
    `${stem}.tsx`,
    join(stem, "index.ts"),
    join(stem, "index.tsx"),
  ]) {
    if (existsSync(join(REPO_ROOT, candidate))) return candidate;
  }
  return null;
}

function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith(".")) return resolveRelative(from, specifier);
  for (const name of FOLLOWED.keys()) {
    if (specifier === name) return exportTarget(name, ".");
    if (specifier.startsWith(`${name}/`))
      return exportTarget(name, `./${specifier.slice(name.length + 1)}`);
  }
  return null;
}

/** Value import / re-export specifiers of one file (`import type` and `export type` carry no code). */
function valueImports(file: string): string[] {
  const source = stripComments(readRepoFile(file));
  const found: string[] = [];
  const statement =
    /(?:^|[;\n])\s*(import|export)\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gu;
  for (const m of source.matchAll(statement)) {
    if (m[2] === undefined && m[4] !== undefined) found.push(m[4]);
  }
  for (const m of source.matchAll(/(?:^|[;\n])\s*import\s+["']([^"']+)["']/gu)) {
    if (m[1] !== undefined) found.push(m[1]);
  }
  return found;
}

/** Every file reachable from `entry`, with the import chain that first reached it. */
function importGraph(entry: string): Map<string, readonly string[]> {
  const reached = new Map<string, readonly string[]>([[entry, [entry]]]);
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const chain = reached.get(file) ?? [file];
    for (const specifier of valueImports(file)) {
      const target = resolveSpecifier(file, specifier);
      if (target === null || reached.has(target)) continue;
      reached.set(target, [...chain, target]);
      queue.push(target);
    }
  }
  return reached;
}

describe("guard: phone entries stay off the import pipeline and proposals", () => {
  it.each(PHONE_ENTRIES)("@cashu/store/%s", (subpath) => {
    const entry = exportTarget("@cashu/store", subpath);
    expect(entry, `@cashu/store exports ${subpath}`).not.toBeNull();
    const graph = importGraph(entry as string);
    // The walk really follows the graph (a broken resolver would pass vacuously).
    expect(graph.size).toBeGreaterThan(1);
    const bad = [...graph]
      .filter(
        ([file]) =>
          FORBIDDEN_FILES.has(file) ||
          (PROPOSAL_FILE.test(`/${file}`) && !ALLOWED_PROPOSAL_FILES.has(file)),
      )
      .map(([, chain]) => chain.map((f) => relative(".", f)).join(" -> "));
    expect(bad, `${subpath} reaches a desktop-only module; cut the barrel import`).toEqual([]);
  });

  it("catches a drag: the walk reaches csvMapping from the importing barrel and proposals from the services barrel", () => {
    const importing = importGraph("packages/domain/src/investments/importing/index.ts");
    expect(importing.has("packages/domain/src/investments/importing/csvMapping.ts")).toBe(true);
    const services = importGraph("packages/store/src/investments/services/index.ts");
    expect([...services.keys()].some((f) => f.includes("/investments/services/proposal"))).toBe(
      true,
    );
  });
});
