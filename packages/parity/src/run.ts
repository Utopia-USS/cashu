/// <reference types="node" />
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { compare, type Diff } from "./compare.ts";
import { optionsFor, type ParityConfig } from "./config.ts";
import { CanonParseError, parseCanonical, sha256Hex } from "./json.ts";

export type Status = "pass" | "fail" | "missing";

export interface CheckReport {
  check: string;
  status: Status;
  goldenRows: number | null;
  actualRows: number | null;
  goldenSha: string;
  actualSha: string | null;
  /** Set when `status` is `fail`: the first difference, a path and a kind, never values. */
  diff?: Diff;
}

export interface Report {
  checks: CheckReport[];
  /** Indexed Python inputs consumed by TS producers, validated but never compared as outputs. */
  oracleInputs: string[];
  /** `*.json` files in the actual dir that are not a check of the golden index (informational). */
  extra: string[];
  counts: Record<Status, number>;
}

export interface RunOptions {
  goldenDir: string;
  actualDir: string;
  /** Exact check names; every other check of the golden index is skipped. */
  only?: readonly string[];
  config: ParityConfig;
  hashKeys?: boolean;
  /** Compare the parsed trees even when the files are byte-identical (exercises the reader). */
  deep?: boolean;
}

export class RunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunError";
  }
}

interface IndexEntry {
  check: string;
  rows: number | null;
  sha256: string;
}

const ORACLE_INPUTS: ReadonlySet<string> = new Set(["mcp.read_raw"]);

function validateOracleInputs(goldenDir: string, index: readonly IndexEntry[]): string[] {
  const inputs = index.filter((entry) => ORACLE_INPUTS.has(entry.check));
  for (const entry of inputs) {
    const bytes = readBytes(join(goldenDir, `${entry.check}.json`));
    if (bytes === null || sha256Hex(bytes) !== entry.sha256)
      throw new RunError(`oracle input ${entry.check} is missing or has a bad indexed hash`);
  }
  return inputs.map((entry) => entry.check);
}

/** Explicit input-only request: validate it, but never claim it was a comparison. */
export function oracleInputOnly(goldenDir: string, name: string): boolean {
  if (!ORACLE_INPUTS.has(name)) return false;
  const index = readIndex(goldenDir);
  if (index === null || !index.some((entry) => entry.check === name))
    throw new RunError(`oracle input ${name} is not indexed`);
  validateOracleInputs(goldenDir, index);
  return true;
}

function readIndex(dir: string): IndexEntry[] | null {
  let text: string;
  try {
    text = readFileSync(join(dir, "index.json"), "utf8");
  } catch {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const list = (raw as { checks?: unknown } | null)?.checks;
  if (!Array.isArray(list)) return null;
  const out: IndexEntry[] = [];
  for (const e of list as { check?: unknown; rows?: unknown; sha256?: unknown }[]) {
    if (typeof e?.check !== "string") continue;
    out.push({
      check: e.check,
      rows: typeof e.rows === "number" ? e.rows : null,
      sha256: typeof e.sha256 === "string" ? e.sha256 : "",
    });
  }
  return out;
}

function readBytes(path: string): Uint8Array | null {
  try {
    return readFileSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RunError(`cannot read ${path}`);
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Names of the checks in a golden dir's index, in index order. */
export function goldenChecks(goldenDir: string): string[] {
  const index = readIndex(goldenDir);
  if (index === null) throw new RunError(`no readable index.json in the golden dir ${goldenDir}`);
  validateOracleInputs(goldenDir, index);
  return index.filter((e) => !ORACLE_INPUTS.has(e.check)).map((e) => e.check);
}

function compareCheck(
  entry: IndexEntry,
  goldenBytes: Uint8Array,
  actualBytes: Uint8Array,
  actualRows: number | null,
  config: ParityConfig,
  hashKeys: boolean,
): { diff?: Diff } {
  const options = { ...optionsFor(config, entry.check), hashKeys };
  let actual: ReturnType<typeof parseCanonical>;
  try {
    actual = parseCanonical(Buffer.from(actualBytes).toString("utf8"));
  } catch (e) {
    if (e instanceof CanonParseError)
      return { diff: { path: "$", kind: "parse", detail: e.message } };
    throw e;
  }
  const golden = parseCanonical(Buffer.from(goldenBytes).toString("utf8"));
  const diff = compare(golden, actual, options);
  if (diff !== null) return { diff };
  if (actualRows !== null && entry.rows !== null && actualRows !== entry.rows) {
    return { diff: { path: "index.rows", kind: "rows", detail: `${entry.rows} vs ${actualRows}` } };
  }
  return {};
}

/** Compare every (selected) check of a golden dir against an actual dir. */
export function runParity(opts: RunOptions): Report {
  const index = readIndex(opts.goldenDir);
  if (index === null) {
    throw new RunError(`no readable index.json in the golden dir ${opts.goldenDir}`);
  }
  const oracleInputs = validateOracleInputs(opts.goldenDir, index);
  const known = new Set(index.filter((e) => !ORACLE_INPUTS.has(e.check)).map((e) => e.check));
  for (const name of opts.only ?? []) {
    if (!known.has(name)) throw new RunError(`unknown check "${name}"`);
  }
  for (const name of Object.keys(opts.config.checks)) {
    if (!known.has(name)) throw new RunError(`config names an unknown check "${name}"`);
  }
  const selected = index.filter(
    (e) => !ORACLE_INPUTS.has(e.check) && (opts.only === undefined || opts.only.includes(e.check)),
  );

  const actualIsDir = isDir(opts.actualDir);
  const actualIndex = actualIsDir ? readIndex(opts.actualDir) : null;
  const actualRowsOf = new Map(actualIndex?.map((e) => [e.check, e.rows]) ?? []);

  const checks: CheckReport[] = [];
  for (const entry of selected) {
    const goldenBytes = readBytes(join(opts.goldenDir, `${entry.check}.json`));
    if (goldenBytes === null)
      throw new RunError(`golden file of check "${entry.check}" is missing`);
    const goldenSha = sha256Hex(goldenBytes);
    const base: CheckReport = {
      check: entry.check,
      status: "pass",
      goldenRows: entry.rows,
      actualRows: null,
      goldenSha,
      actualSha: null,
    };
    if (goldenSha !== entry.sha256) {
      checks.push({ ...base, status: "fail", diff: { path: "index.sha256", kind: "golden-sha" } });
      continue;
    }
    const actualBytes = actualIsDir ? readBytes(join(opts.actualDir, `${entry.check}.json`)) : null;
    if (actualBytes === null) {
      checks.push({ ...base, status: "missing" });
      continue;
    }
    const actualSha = sha256Hex(actualBytes);
    const actualRows = actualRowsOf.get(entry.check) ?? null;
    const report: CheckReport = { ...base, actualSha, actualRows };
    if (actualSha !== goldenSha || opts.deep === true) {
      const { diff } = compareCheck(
        entry,
        goldenBytes,
        actualBytes,
        actualRows,
        opts.config,
        opts.hashKeys === true,
      );
      if (diff !== undefined) {
        checks.push({ ...report, status: "fail", diff });
        continue;
      }
    }
    checks.push(report);
  }

  const extra =
    actualIsDir && opts.only === undefined
      ? readdirSync(opts.actualDir)
          .filter((f) => f.endsWith(".json") && f !== "index.json")
          .map((f) => f.slice(0, -".json".length))
          .filter((name) => !known.has(name))
          .sort()
      : [];
  const counts: Record<Status, number> = { pass: 0, fail: 0, missing: 0 };
  for (const c of checks) counts[c.status]++;
  return { checks, oracleInputs, extra, counts };
}
