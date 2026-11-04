#!/usr/bin/env node
import { closeSync, constants, fsyncSync, openSync, realpathSync, writeSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { MigrationError } from "./contract.js";
import { importPythonDataDir, verifyPythonMigration } from "./oneShot.js";

function argument(value: string | undefined, flag: string): string {
  if (!value || !isAbsolute(value) || resolve(value) !== value || value.includes("\0"))
    throw new Error(`${flag} needs an absolute canonical path`);
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
  if (command !== "import" && command !== "verify") throw new Error("expected import or verify");
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
      throw new Error("invalid or duplicate option");
    flags.set(flag, value);
  }
  const sourceDir = realpathSync(argument(flags.get("--source"), "--source"));
  const targetDir = argument(flags.get("--target"), "--target");
  const recoveryFile = flags.get("--recovery-file");
  if (command === "import" && !recoveryFile) throw new Error("import requires --recovery-file");
  if (command === "verify" && recoveryFile) throw new Error("verify does not take --recovery-file");
  const atText = flags.get("--at");
  if (command === "verify" && !atText) throw new Error("verify requires the import --at value");
  const at = atText === undefined ? Date.now() : Number(atText);
  if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).valueOf()))
    throw new Error("--at needs a Unix timestamp in milliseconds");
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

export async function migrationCli(argv: readonly string[]): Promise<number> {
  try {
    const args = parse(argv);
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
    return 1;
  }
}

if (process.argv[1] === import.meta.filename) {
  process.exitCode = await migrationCli(process.argv.slice(2));
}
