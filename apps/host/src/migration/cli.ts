#!/usr/bin/env node
import { closeSync, constants, fsyncSync, lstatSync, openSync, realpathSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import {
  buildRecoveryPrompt,
  classifyStartupError,
  type PromptLang,
  startupFailure,
  startupFailureReport,
} from "@cashu/host-protocol/startup-failure";
import {
  startupReportPaths,
  writeStartupFailureRecord,
  writeStartupFailureReport,
} from "@cashu/node-host";
import { MigrationError } from "./contract.js";
import { importPythonDataDir, verifyPythonMigration } from "./oneShot.js";

/** Exit code of a malformed command line (EX_USAGE). */
const USAGE_EXIT = 64;

/** A malformed command line. Its message is fixed usage text, never a value from the arguments. */
class MigrationUsageError extends Error {
  readonly code = "usage_invalid";
  constructor(message: string) {
    super(message);
    this.name = "MigrationUsageError";
  }
}

function argument(value: string | undefined, flag: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes("\0"))
    throw new MigrationUsageError(`${flag} needs an absolute canonical path`);
  return value;
}

function parse(args: readonly string[]): {
  command: "import" | "verify";
  sourceDir: string;
  targetDir: string;
  recoveryFile?: string;
  at: number;
} {
  const [command, ...rest] = args;
  if (command !== "import" && command !== "verify")
    throw new MigrationUsageError("expected import or verify");
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (
      !flag ||
      !value ||
      !["--source", "--target", "--recovery-file", "--at"].includes(flag) ||
      flags.has(flag)
    )
      throw new MigrationUsageError("invalid or duplicate option");
    flags.set(flag, value);
  }
  let sourceDir: string;
  try {
    sourceDir = realpathSync(argument(flags.get("--source"), "--source"));
  } catch (error) {
    if (error instanceof MigrationUsageError) throw error;
    throw new MigrationUsageError("--source must be an existing directory");
  }
  const targetDir = argument(flags.get("--target"), "--target");
  const recoveryFile = flags.get("--recovery-file");
  if (command === "import" && !recoveryFile)
    throw new MigrationUsageError("import requires --recovery-file");
  if (command === "verify" && recoveryFile)
    throw new MigrationUsageError("verify does not take --recovery-file");
  const atText = flags.get("--at");
  if (command === "verify" && !atText)
    throw new MigrationUsageError("verify requires the import --at value");
  const at = atText === undefined ? Date.now() : Number(atText);
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).valueOf()))
    throw new MigrationUsageError("--at needs a Unix timestamp in milliseconds");
  return {
    command,
    sourceDir,
    targetDir,
    at,
    ...(recoveryFile === undefined
      ? {}
      : { recoveryFile: argument(recoveryFile, "--recovery-file") }),
  };
}

export function assertRecoveryFileDestination(
  path: string,
  sourceDir: string,
  targetDir: string,
): void {
  const parent = realpathSync(dirname(path));
  if (parent !== dirname(path)) throw new Error("recovery file parent must be canonical");
  for (const root of [realpathSync(sourceDir), targetDir]) {
    const nested = relative(root, path);
    if (nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested)))
      throw new Error("recovery file must be outside source and target");
  }
}

function saveWords(path: string, sourceDir: string, targetDir: string, words: string): void {
  assertRecoveryFileDestination(path, sourceDir, targetDir);
  const parent = dirname(path);
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const bytes = Buffer.from(`${words}\n`);
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("recovery file write failed");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

/** The prompt language: CASHU_LANG, else the process locale, else English. */
function promptLang(env: NodeJS.ProcessEnv): PromptLang {
  const pinned = env.CASHU_LANG?.trim().toLowerCase();
  if (pinned === "pl" || pinned === "en") return pinned;
  return Intl.DateTimeFormat().resolvedOptions().locale.toLowerCase().startsWith("pl")
    ? "pl"
    : "en";
}

function isPrivateDir(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * A failed `verify` leaves the typed failure record and a redacted report pair (the agent prompt)
 * in the target's `diagnostics/`, the same files the app's recovery screen writes. Best effort:
 * returns the prompt file, or null when the target is not an existing directory.
 */
export function recordVerifyFailure(
  targetDir: string,
  error: unknown,
  lang: PromptLang,
  at: Date = new Date(),
): string | null {
  if (!isPrivateDir(targetDir)) return null;
  try {
    const classified = classifyStartupError(error);
    const failure =
      classified.code === "migrate_verify_mismatch"
        ? classified
        : startupFailure("migrate_verify_mismatch", "migration_failed");
    writeStartupFailureRecord(targetDir, failure, "migrate-cli", at.valueOf());
    const paths = startupReportPaths(targetDir, at);
    const report = startupFailureReport({
      failure,
      at,
      appVersion: "",
      build: "migrate-cli",
      dataDir: targetDir,
      home: homedir(),
      reportFile: paths.text,
      logText: "",
    });
    writeStartupFailureReport(paths, report, buildRecoveryPrompt(report, lang));
    return paths.text;
  } catch {
    return null;
  }
}

export async function migrationCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (error) {
    const message = error instanceof MigrationUsageError ? error.message : "invalid arguments";
    process.stderr.write(`cashu-migrate: usage_invalid (${message})\n`);
    return USAGE_EXIT;
  }
  try {
    const recoveryFile = args.recoveryFile;
    const result =
      args.command === "import"
        ? await importPythonDataDir({
            sourceDir: args.sourceDir,
            targetDir: args.targetDir,
            at: args.at,
            async saveRecoveryWords(words) {
              if (!recoveryFile) throw new Error("recovery file required");
              saveWords(recoveryFile, args.sourceDir, args.targetDir, words);
            },
          })
        : await verifyPythonMigration({
            sourceDir: args.sourceDir,
            targetDir: args.targetDir,
            at: args.at,
          });
    process.stdout.write(
      `${JSON.stringify({
        status: "pass",
        command: args.command,
        at: args.at,
        profiles: result.profiles,
        financialTables: result.financialTables,
        financialRows: result.financialRows,
        vaults: result.vaults.map(({ ordinal, vaultId, viewHash }) => ({
          ordinal,
          vaultId,
          viewHash,
        })),
      })}\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof MigrationError ? error.code : "migration_failed";
    process.stderr.write(`cashu-migrate: ${code}\n`);
    if (args.command === "verify") {
      const report = recordVerifyFailure(args.targetDir, error, promptLang(env));
      if (report !== null) process.stderr.write(`cashu-migrate: report ${report}\n`);
    }
    return 1;
  }
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = await migrationCli(process.argv.slice(2));
}
