/// <reference types="node" />
// File discovery shared by the guard tests and the TRANSITIONAL report.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

const SKIP_DIRS = new Set(["node_modules", "dist", ".turbo", "coverage", "build", "test-results"]);

/** Repo-relative paths of files under `dirs` (repo-relative) whose path matches `include`. */
export function listFiles(dirs: readonly string[], include: RegExp): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(join(abs, entry.name));
      } else {
        const rel = relative(REPO_ROOT, join(abs, entry.name));
        if (include.test(rel)) out.push(rel);
      }
    }
  };
  for (const dir of dirs) {
    const abs = join(REPO_ROOT, dir);
    if (existsSync(abs)) walk(abs);
  }
  return out.sort();
}

export function readRepoFile(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

/** Test code, stories and test support: exempt from the production-code guards. */
export const TEST_FILE = /(\.test\.tsx?$|\.stories\.tsx$|\/testing\/|\/test-fixtures\/|\/e2e\/)/;

export interface WorkspacePackage {
  dir: string;
  manifest: {
    name?: string;
    exports?: unknown;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
  };
}

/** Every workspace member of the TS monorepo (packages/*, apps/*, tools/arch). */
export function workspacePackages(): WorkspacePackage[] {
  const dirs: string[] = ["tools/arch"];
  for (const group of ["packages", "apps"]) {
    const abs = join(REPO_ROOT, group);
    if (!existsSync(abs)) continue;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(abs, e.name, "package.json")))
        dirs.push(`${group}/${e.name}`);
    }
  }
  return dirs.sort().map((dir) => ({
    dir,
    manifest: JSON.parse(readRepoFile(`${dir}/package.json`)) as WorkspacePackage["manifest"],
  }));
}

/** Strips // and /* *\/ comments (good enough for line-based guards; keeps line numbers). */
export function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}
