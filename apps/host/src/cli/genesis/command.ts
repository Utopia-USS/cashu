// `cashu genesis --data-dir X --out Y --keys K [--init-keys] [--fold] [--no-strict] [--keep-run]`
// (S26 spec 9.4): the genesis event log of every profile of a Python data dir, for lab and dev runs.
// A host command (S56d): the shim forwards the argv, the host runs it (only the host opens stores).
// Order: refusals (exit 64, nothing read yet), source manifest, copy into `<tmp>/genesis-run-<run>/`,
// manifest again (the copy is consistent), `PRAGMA quick_check` on the read-only copy, keys, genesis,
// the out dir, the optional fold, the source manifest a last time. stdout carries counts, short
// hashes and the exit status; never slugs, names, values, vault ids or salts. Exit codes: 0 ok,
// 64 usage or refusal, 65 data or genesis error.
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { isAbsolute, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { RefusalError, refusePaths, resolveReal } from "@cashu/node-host";
import { openNodeSqlite } from "@cashu/node-host/sqlite";
import type { SqlDriver } from "@cashu/store";
import * as genesis from "@cashu/store/genesis";
import { assertUnchanged, copyRun, manifest, runFiles, SourceChangedError } from "./copy.js";
import { FoldError, foldVault } from "./fold.js";
import { initKeys, KeysFileError, readKeys } from "./keys.js";
import { createOut, type VaultSummary, vaultDir, writeManifest, writeVault } from "./write.js";

/** The process surroundings of a run, injected so tests use a fake home and temp dir. */
export interface CliEnv {
  readonly home: string;
  readonly tmpDir: string;
  /** Names this run's private copy (`genesis-run-<runId>`): unique among the host's runs. */
  readonly runId: string;
  readonly now: () => number;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

const USAGE =
  "usage: cashu genesis --data-dir <dir> --out <new dir> --keys <file> [--init-keys] [--fold] [--no-strict] [--keep-run]\n" +
  "       (absolute paths only)";

/** A data or genesis error found by the command itself (exit 65). */
class DataError extends Error {
  readonly exitCode = 65;
}

/** A usage error (exit 64). */
class UsageError extends Error {
  readonly exitCode = 64;
}

const short = (hex: string) => hex.slice(0, 12);

/** The three paths, resolved (`resolveReal`). */
interface GenesisPaths {
  readonly dataDir: string;
  readonly out: string;
  readonly keys: string;
}

interface Options extends GenesisPaths {
  readonly initKeys: boolean;
  readonly fold: boolean;
  readonly strict: boolean;
  readonly keepRun: boolean;
}

function parse(argv: readonly string[]): Options {
  let values: ReturnType<typeof parseOptions>["values"];
  try {
    values = parseOptions(argv).values;
  } catch {
    throw new UsageError(USAGE);
  }
  const path = (flag: "data-dir" | "out" | "keys") => {
    const v = values[flag];
    if (v === undefined || !isAbsolute(v)) throw new UsageError(USAGE);
    return resolveReal(normalize(v));
  };
  return {
    dataDir: path("data-dir"),
    out: path("out"),
    keys: path("keys"),
    initKeys: values["init-keys"],
    fold: values.fold,
    strict: values.strict,
    keepRun: values["keep-run"],
  };
}

function parseOptions(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    strict: true,
    allowPositionals: false,
    allowNegative: true,
    options: {
      "data-dir": { type: "string" },
      out: { type: "string" },
      keys: { type: "string" },
      "init-keys": { type: "boolean", default: false },
      fold: { type: "boolean", default: false },
      strict: { type: "boolean", default: true },
      "keep-run": { type: "boolean", default: false },
    },
  });
}

/** Existence checks that need no reading of data (exit 64). */
function checkTargets(o: Options): void {
  if (!existsSync(join(o.dataDir, "cashu.db"))) {
    throw new UsageError("--data-dir has no cashu.db");
  }
  if (existsSync(o.out)) {
    if (!statSync(o.out).isDirectory() || readdirSync(o.out).length > 0) {
      throw new RefusalError("--out exists and is not an empty directory");
    }
  }
  if (o.initKeys && existsSync(o.keys)) {
    throw new RefusalError("--init-keys would overwrite an existing keys file");
  }
  if (!o.initKeys && !existsSync(o.keys)) {
    throw new UsageError("--keys does not exist (create it once with --init-keys)");
  }
}

function quickCheck(db: SqlDriver): void {
  const rows = db.prepare("PRAGMA quick_check").all<{ quick_check?: unknown }>();
  if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
    throw new DataError(`the database copy fails PRAGMA quick_check (${rows.length} problems)`);
  }
}

function profileSlugs(db: SqlDriver): string[] {
  try {
    return db
      .prepare("SELECT slug FROM profiles ORDER BY id")
      .all<{ slug: string }>()
      .map((r) => r.slug);
  } catch {
    throw new DataError("the database copy has no readable profiles table");
  }
}

/** Removes what this run wrote into `out` (it was missing or empty before the run). */
function discardOut(out: string, existed: boolean): void {
  if (!existsSync(out)) return;
  if (!existed) {
    rmSync(out, { recursive: true, force: true });
    return;
  }
  for (const name of readdirSync(out)) rmSync(join(out, name), { recursive: true, force: true });
}

function run(o: Options, env: CliEnv): void {
  const say = env.stdout;
  const before = manifest(o.dataDir);
  say(`genesis: source ${before.files} files, sha256 ${short(before.sha256)}`);
  const runDir = join(env.tmpDir, `genesis-run-${env.runId}`);
  rmSync(runDir, { recursive: true, force: true });
  const outExisted = existsSync(o.out);
  let db: SqlDriver | undefined;
  let keysCreated = false;
  let done = false;
  try {
    copyRun(o.dataDir, runDir);
    assertUnchanged(before, manifest(o.dataDir));
    const copy = join(runDir, "cashu.db");
    if (!existsSync(copy)) throw new DataError("the run copy has no cashu.db");
    db = openNodeSqlite(copy, { readOnly: true });
    quickCheck(db);
    const keys = o.initKeys ? initKeys(o.keys, profileSlugs(db)) : readKeys(o.keys);
    keysCreated = o.initKeys;
    if (o.initKeys) say(`genesis: keys created for ${keys.size} vaults (mode 0600)`);
    const result = genesis.genesis({ driver: db, files: runFiles(runDir) }, keys, {
      strict: o.strict,
      now: env.now(),
    });
    say(
      `genesis: schema ${result.schema}, ${result.vaults.length} vaults, strict ${o.strict ? "on" : "off"}`,
    );
    createOut(o.out);
    const summaries: VaultSummary[] = [];
    for (const vault of result.vaults) {
      let summary = writeVault(o.out, vault);
      say(
        `vault ${summary.ordinal}: ${summary.events} events, ${summary.ids} ids, log ${short(summary.logSha256)}, W ${summary.wall.slice(0, 10)}`,
      );
      if (o.fold) {
        const k = keys.get(vault.slug);
        if (k === undefined) throw new DataError(`no keys for vault ${vault.ordinal}`);
        const fold = foldVault(join(vaultDir(o.out, vault.ordinal), "view.sqlite"), vault, k);
        say(
          `vault ${summary.ordinal}: folded, invariants ok, view rows ${fold.rows} in ${fold.tables} tables = exported, view ${short(fold.view)}`,
        );
        summary = { ...summary, view: fold.view };
      }
      summaries.push(summary);
    }
    assertUnchanged(before, manifest(o.dataDir));
    writeManifest(o.out, {
      source: before,
      schema: result.schema,
      vaults: summaries,
      report: result.report,
    });
    say(`genesis: source unchanged, sha256 ${short(before.sha256)}`);
    done = true;
  } finally {
    db?.close();
    if (o.keepRun) say(`genesis: run copy kept at ${runDir}`);
    else rmSync(runDir, { recursive: true, force: true });
    if (!done) {
      discardOut(o.out, outExisted);
      // A failed first run leaves no keys behind, so the retry can use --init-keys again.
      if (keysCreated) rmSync(o.keys, { force: true });
    }
  }
}

const exitCodeOf = (e: unknown): number | undefined =>
  e instanceof RefusalError ||
  e instanceof UsageError ||
  e instanceof KeysFileError ||
  e instanceof DataError ||
  e instanceof SourceChangedError ||
  e instanceof FoldError ||
  e instanceof genesis.GenesisError
    ? e.exitCode
    : undefined;

/** Runs `cashu genesis` with `argv` (after the command name); returns the exit code. */
export function genesisCommand(argv: readonly string[], env: CliEnv): number {
  let code = 0;
  try {
    const options = parse(argv);
    refusePaths(
      {
        dataDir: { label: "--data-dir", path: options.dataDir },
        outputs: [
          { label: "--out", path: options.out },
          { label: "--keys", path: options.keys },
        ],
      },
      env.home,
    );
    checkTargets(options);
    run(options, env);
  } catch (e) {
    const known = exitCodeOf(e);
    if (known !== undefined && e instanceof Error) {
      const detail = e instanceof genesis.GenesisError ? ` (${e.code})` : "";
      env.stderr(`genesis: ${e.message}${detail}`);
      code = known;
    } else {
      // An unexpected error: its message may quote data (an SQLite or decoding error), so only the
      // error's name and the stack frames are shown.
      const stack = e instanceof Error ? (e.stack ?? "").split("\n").slice(1).join("\n") : "";
      env.stderr(`genesis: unexpected ${e instanceof Error ? e.name : typeof e}\n${stack}`);
      code = 65;
    }
  }
  env.stdout(`genesis: exit ${code}`);
  return code;
}
