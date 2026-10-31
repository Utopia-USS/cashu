/// <reference types="node" />
// `pnpm arch:check`: every architecture check of the TypeScript monorepo, run in parallel, reported
// in a fixed order, non-zero exit when any check fails. The rules are explained in the dev skills
// (tools/claude-dev/skills/cashu-ts-architecture and cashu-ui); one file: tools/claude-dev/scripts/check-file.sh.
import { spawn } from "node:child_process";
import { join } from "node:path";
import { depcruise, formatViolation } from "./depcruise.ts";
import { formatMarkers, transitionalMarkers } from "./guards/transitional.ts";
import { REPO_ROOT } from "./repo.ts";

interface StepResult {
  name: string;
  what: string;
  ok: boolean;
  output: string;
}

const ROOT_BIN = join(REPO_ROOT, "node_modules/.bin");
const TOOLS_BIN = join(REPO_ROOT, "tools/arch/node_modules/.bin");

function run(
  name: string,
  what: string,
  cmd: string,
  args: string[],
  cwd = REPO_ROOT,
): Promise<StepResult> {
  return new Promise((resolveStep) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
    });
    let output = "";
    child.stdout.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      output += d.toString();
    });
    child.on("error", (e) => resolveStep({ name, what, ok: false, output: String(e) }));
    child.on("close", (code) => resolveStep({ name, what, ok: code === 0, output: output.trim() }));
  });
}

async function depcruiseStep(): Promise<StepResult> {
  const what = "layer direction, module internals, pure Views, cycles";
  try {
    const violations = await depcruise();
    return {
      name: "dependency-cruiser",
      what,
      ok: violations.length === 0,
      output: violations.map(formatViolation).join("\n"),
    };
  } catch (e) {
    return { name: "dependency-cruiser", what, ok: false, output: String(e) };
  }
}

const steps: Promise<StepResult>[] = [
  run("biome", "per-folder import bans, private imports, lint", join(ROOT_BIN, "biome"), [
    "lint",
    "--diagnostic-level=error",
    "--max-diagnostics=200",
    "packages",
    "apps",
    "tools/arch",
  ]),
  run("eslint", "React hooks + React Compiler rules (*.tsx, use*.ts)", join(TOOLS_BIN, "eslint"), [
    "--config",
    "tools/arch/eslint.config.js",
    "--max-warnings=0",
    "--no-error-on-unmatched-pattern",
    "--cache",
    "--cache-location",
    "node_modules/.cache/eslint-arch/",
    "packages",
    "apps",
  ]),
  depcruiseStep(),
  run("knip", "unused files, exports, types and dependencies", join(TOOLS_BIN, "knip"), [
    "--config",
    "tools/arch/knip.jsonc",
    "--no-progress",
    "--no-config-hints",
  ]),
  // TRANSITIONAL(arch-tools): TS 6 pinned in tools/arch for parsing only, until typescript-eslint and
  // dependency-cruiser read TS 7; so sherif sees two typescript versions. All else stays single-version.
  // TRANSITIONAL(frontend-retirement): the legacy SPA (frontend/, package cashu-dashboard) stays on React 18
  // while apps/mobile (Expo SDK 58) needs React 19; like knip, sherif does not judge the legacy SPA. Drop the
  // flag with frontend/ once the renderer lives in apps/.
  run("sherif", "package.json hygiene, one version per dependency", join(TOOLS_BIN, "sherif"), [
    "--ignore-dependency",
    "typescript",
    "--ignore-package",
    "cashu-dashboard",
  ]),
  run(
    "guards",
    "raw style literals in apps, PL/EN catalog parity, story coverage, exports maps, React Compiler",
    join(ROOT_BIN, "vitest"),
    ["run", "--reporter=verbose"],
    join(REPO_ROOT, "tools/arch"),
  ),
];

const started = Date.now();
const results = await Promise.all(steps);
let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`\n${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.what})`);
  if (!r.ok && r.output) console.log(r.output.replace(/^/gm, "    "));
  if (r.ok && r.name === "guards") {
    const skipped = r.output.split("\n").filter((l) => /SKIPPED/.test(l));
    for (const s of skipped) console.log(`    ${s.trim()}`);
  }
}
console.log(
  `\nREPORT  transitional code (not a failure)\n${formatMarkers(transitionalMarkers()).replace(/^/gm, "    ")}`,
);
const seconds = ((Date.now() - started) / 1000).toFixed(1);
console.log(
  `\narch:check ${failed ? `FAILED: ${failed} of ${results.length} checks` : `passed: ${results.length} checks`} in ${seconds}s`,
);
process.exit(failed ? 1 : 0);
