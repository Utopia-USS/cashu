// Package hygiene the linters cannot see: exports maps (they keep private files private) and the
// React Compiler being on wherever React renders.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, readRepoFile, workspacePackages } from "../repo.ts";

const packages = workspacePackages();

/** Leaf targets of an exports map (conditions flattened). */
function exportTargets(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (value && typeof value === "object") return Object.values(value).flatMap(exportTargets);
  return [];
}

describe("guard: every workspace package declares an exports map", () => {
  it.each(packages.map((p) => [p.dir, p] as const))("%s", (_dir, pkg) => {
    const exportsMap = pkg.manifest.exports;
    expect(
      exportsMap && typeof exportsMap === "object" && !Array.isArray(exportsMap),
      `${pkg.dir}/package.json needs an "exports" object: only what it lists is importable by other packages`,
    ).toBe(true);
    const keys = Object.keys(exportsMap as object);
    const wildcards = keys.filter((k) => k.includes("*"));
    expect(wildcards, `${pkg.dir}: no wildcard subpaths, they re-expose private files`).toEqual([]);
    const missing = exportTargets(exportsMap).filter(
      (t) => !existsSync(join(REPO_ROOT, pkg.dir, t)),
    );
    expect(missing, `${pkg.dir}: exports point at missing files`).toEqual([]);
  });
});

/** True when an Expo app config turns the React Compiler on. */
function expoCompilerOn(dir: string): boolean {
  for (const name of ["app.json", "app.config.ts", "app.config.js"]) {
    const file = join(dir, name);
    if (
      existsSync(join(REPO_ROOT, file)) &&
      /["']?reactCompiler["']?\s*:\s*true/.test(readRepoFile(file))
    )
      return true;
  }
  return false;
}

describe("guard: React Compiler is on in every React app", () => {
  const reactApps = packages.filter((p) => {
    const deps = { ...p.manifest.dependencies, ...p.manifest.devDependencies };
    return p.dir.startsWith("apps/") && ("react" in deps || "react-native" in deps);
  });

  it(`apps rendering React compile with the React Compiler (${reactApps.length} React apps)`, () => {
    const off = reactApps.filter((p) => {
      const deps = { ...p.manifest.dependencies, ...p.manifest.devDependencies };
      return !("babel-plugin-react-compiler" in deps) && !("expo" in deps && expoCompilerOn(p.dir));
    });
    expect(
      off.map((p) => p.dir),
      "React apps without the compiler: Expo sets experiments.reactCompiler in app.json; the Electron renderer adds babel-plugin-react-compiler to its Vite React plugin",
    ).toEqual([]);
  });
});

describe("guard: every vitest package wires both test tiers", () => {
  const vitestPackages = packages.filter((p) => p.manifest.scripts?.test?.startsWith("vitest"));

  it.each(vitestPackages.map((p) => [p.dir, p] as const))("%s", (_dir, pkg) => {
    const config = join(pkg.dir, "vitest.config.ts");
    expect(
      existsSync(join(REPO_ROOT, config)) && /\btiered\(/.test(readRepoFile(config)),
      `${config} must be \`export default tiered(...)\` from vitest.tiers.ts: without it a *.exhaustive.test.ts file here would run in the fast tier (references/testing.md, "Test tiers")`,
    ).toBe(true);
    expect(
      pkg.manifest.scripts?.["test:exhaustive"],
      `${pkg.dir}/package.json needs "test:exhaustive": "CASHU_TEST_TIER=exhaustive vitest run --passWithNoTests"`,
    ).toBe("CASHU_TEST_TIER=exhaustive vitest run --passWithNoTests");
  });
});
