/// <reference types="node" />
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig } from "./config.ts";
import { formatReport, reportToJson } from "./report.ts";
import { goldenChecks, oracleInputOnly, RunError, runParity } from "./run.ts";
import { checkStaleness, formatStaleness, readTreeState, type TreeState } from "./staleness.ts";

const USAGE = `Usage: pnpm parity --dataset lab|demo [options]

Compares a TypeScript output dir against the Python goldens. Prints per check pass / fail /
missing, row counts, short hashes and, on failure, the JSON path of the first difference. It never
prints values (the lab dataset is real data).

Options:
  --dataset <lab|demo>   golden set: lab = <lab dir>/parity/out/lab, demo = parity/golden-demo
  --check <name>         only this check (repeatable; a trailing * matches a prefix, e.g. 'investments.*')
  --actual <dir>         the TS output dir (default <lab dir>/parity/ts-out/<dataset>)
  --out <dir>            golden root: compares against <dir>/<dataset> (the dir golden.py --out wrote;
                         default: the shared <lab dir>/parity/out for lab, which only lab/ts-stack HEAD
                         writes, and parity/golden-demo for demo)
  --golden <dir>         override the golden dir (wins over --out)
  --config <file>        tolerance config (default packages/parity/parity.config.json)
  --allow-missing        do not fail on checks that have no actual file yet
  --allow-stale          compare even when an input is not from the commit under test (git HEAD of
                         this tree); reported loudly. Without it such a run is refused (exit 70).
  --hash-keys            print every object key in a path as <key:hash> (default: only schema-like keys)
  --deep                 compare parsed trees even when the files are byte-identical
  --json                 print the report as JSON (full hashes)
  -h, --help

Lab dir: $CASHU_LAB_DIR or ~/cashu-lab. Relative paths resolve against the directory pnpm was run in.
Staleness guard: the golden dir, the actual dir and every input its producers recorded in index.json
must carry the source commit of HEAD; a committed golden set (parity/golden-demo) must equal the
shared goldens of its dataset when those are at HEAD.
Exit code: 0 all pass, 1 a check failed, 2 only missing checks, 64 bad usage, 70 golden or config
problem or stale inputs.
`;

export interface Io {
  out: (text: string) => void;
  err: (text: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  /** The commit under test (tests inject it); default: git HEAD of this repo. */
  tree?: () => TreeState | null;
}

/** The repository root: this file is `packages/parity/src/cli.ts`. */
const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
const DEFAULT_CONFIG = resolve(import.meta.dirname, "..", "parity.config.json");

function selectChecks(patterns: string[], all: string[]): string[] {
  const out = new Set<string>();
  for (const p of patterns) {
    const matched = p.endsWith("*")
      ? all.filter((c) => c.startsWith(p.slice(0, -1)))
      : all.filter((c) => c === p);
    if (matched.length === 0) throw new RunError(`unknown check "${p}"`);
    for (const m of matched) out.add(m);
  }
  return [...out];
}

/** Run the CLI; returns the exit code. */
export async function main(argv: string[], io: Io): Promise<number> {
  let args: ReturnType<typeof parseCli>;
  try {
    args = parseCli(argv);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 64;
  }
  const { values } = args;
  if (values.help === true) {
    io.out(USAGE);
    return 0;
  }
  const dataset = values.dataset;
  if (dataset !== "lab" && dataset !== "demo") {
    io.err(`--dataset must be lab or demo\n\n${USAGE}`);
    return 64;
  }
  const base = io.env.INIT_CWD ?? io.cwd;
  const abs = (p: string) => (isAbsolute(p) ? p : resolve(base, p));
  const labDir = io.env.CASHU_LAB_DIR ?? join(homedir(), "cashu-lab");
  const goldenDir = abs(
    values.golden ??
      (values.out !== undefined
        ? join(abs(values.out), dataset)
        : dataset === "demo"
          ? join(REPO_ROOT, "parity", "golden-demo")
          : join(labDir, "parity", "out", "lab")),
  );
  const actualDir = abs(values.actual ?? join(labDir, "parity", "ts-out", dataset));
  try {
    if (values.check.length === 1 && oracleInputOnly(goldenDir, values.check[0] ?? "")) {
      io.out(`${values.check[0]}: oracle input, indexed hash validated; not a comparison\n`);
      return 0;
    }
    const config = loadConfig(abs(values.config ?? DEFAULT_CONFIG));
    const only =
      values.check.length > 0 ? selectChecks(values.check, goldenChecks(goldenDir)) : undefined;
    const checks = only ?? goldenChecks(goldenDir);
    const staleness = checkStaleness({
      dataset,
      goldenDir,
      actualDir,
      checks,
      head: (io.tree ?? (() => readTreeState(REPO_ROOT)))(),
      repoRoot: REPO_ROOT,
      labDir,
    });
    const allowStale = values["allow-stale"] === true;
    const stale = staleness.stale.length > 0;
    if (stale && !allowStale) {
      io.err(formatStaleness(staleness, false));
      return 70;
    }
    const banner = stale ? formatStaleness(staleness, true) : "";
    const notes = staleness.notes.map((n) => `note: ${n}\n`).join("");
    const report = runParity({
      goldenDir,
      actualDir,
      config,
      hashKeys: values["hash-keys"] === true,
      deep: values.deep === true,
      ...(only ? { only } : {}),
    });
    if (values.json === true) {
      io.out(reportToJson({ ...report, staleness: { ...staleness, allowed: stale } }));
      if (stale) io.err(banner);
    } else {
      io.out(`${banner}${notes}${formatReport(report, `parity: ${dataset}`)}${banner}`);
    }
    if (report.counts.fail > 0) return 1;
    if (report.counts.missing > 0 && values["allow-missing"] !== true) return 2;
    return 0;
  } catch (e) {
    if (e instanceof RunError || e instanceof ConfigError) {
      io.err(`${e.message}\n`);
      return 70;
    }
    throw e;
  }
}

function parseCli(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      dataset: { type: "string" },
      check: { type: "string", multiple: true, default: [] },
      actual: { type: "string" },
      golden: { type: "string" },
      out: { type: "string" },
      config: { type: "string" },
      "allow-missing": { type: "boolean" },
      "allow-stale": { type: "boolean" },
      "hash-keys": { type: "boolean" },
      deep: { type: "boolean" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main(process.argv.slice(2), {
    out: (t) => process.stdout.write(t),
    err: (t) => process.stderr.write(t),
    env: process.env,
    cwd: process.cwd(),
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (e: unknown) => {
      process.stderr.write(`parity failed: ${e instanceof Error ? e.name : "error"}\n`);
      process.exitCode = 70;
    },
  );
}
