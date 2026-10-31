/// <reference types="node" />
// Runs dependency-cruiser through its API (the CLI refuses odd node releases such as 23.x; the API
// does not care) and prints one line per violation: rule, edge, and the rule's explanation.
//   node --experimental-strip-types tools/arch/src/depcruise.ts            whole graph
//   node --experimental-strip-types tools/arch/src/depcruise.ts <file>...  only edges from these files
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cruise, type ICruiseResult, type IForbiddenRuleType } from "dependency-cruiser";

export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** Roots of the whole-graph run. */
export const GRAPH_ROOTS = ["packages", "apps", "tools/arch/src"];

interface DepcruiseConfig {
  forbidden: IForbiddenRuleType[];
  options: Record<string, unknown>;
}

export interface DepViolation {
  rule: string;
  from: string;
  to: string;
  message: string;
}

function loadConfig(): DepcruiseConfig {
  const require = createRequire(import.meta.url);
  return require("../depcruise.config.cjs") as DepcruiseConfig;
}

/** Cruises `files` (repo-relative or absolute) or, when empty, the whole graph. */
export async function depcruise(files: readonly string[] = []): Promise<DepViolation[]> {
  const config = loadConfig();
  const comments = new Map(config.forbidden.map((r) => [r.name ?? "", r.comment ?? ""]));
  const targets = files.map((f) => relative(REPO_ROOT, resolve(f)));
  const cwd = process.cwd();
  process.chdir(REPO_ROOT);
  try {
    const { output } = await cruise(targets.length ? targets : GRAPH_ROOTS, {
      ...config.options,
      // One file only needs its own edges (and a cycle needs the graph, so cycles are full-run only).
      ...(targets.length ? { maxDepth: 1 } : {}),
      validate: true,
      ruleSet: { forbidden: config.forbidden },
    });
    const result = output as ICruiseResult;
    return result.summary.violations
      .filter((v) => !targets.length || targets.includes(v.from))
      .filter((v) => !(targets.length && v.rule.name === "no-circular"))
      .map((v) => ({
        rule: v.rule.name,
        from: v.from,
        to: v.cycle ? v.cycle.map((c) => c.name).join(" -> ") : v.to,
        message: comments.get(v.rule.name) ?? "",
      }));
  } finally {
    process.chdir(cwd);
  }
}

export function formatViolation(v: DepViolation): string {
  return `${v.from}: [depcruise/${v.rule}] imports ${v.to}\n    ${v.message}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const violations = await depcruise(process.argv.slice(2));
  for (const v of violations) console.error(formatViolation(v));
  if (violations.length) {
    console.error(`dependency-cruiser: ${violations.length} violation(s)`);
    process.exit(1);
  }
}
