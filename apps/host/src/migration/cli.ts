// `cashu-host migrate` (the `cashu migrate` of the shim, and the desktop's "Import my data"):
//   migrate --data-dir <D> [--recovery-file <path>] [--json]   the in-place import (inPlace.ts)
//   (human mode needs --recovery-file, except on an already migrated D: that only reports it)
//   migrate verify --data-dir <D> [--json]                     re-checks a finished import; read-only
// Human mode prints stage lines and a count-only result in PL / EN; the recovery words go only to the
// new `--recovery-file` (O_EXCL, 0600, outside D). `--json` speaks the child protocol of
// @cashu/host-protocol/startup-failure (migrateProtocol.ts): the words travel once on stdout and the
// run blocks for one stdin line (`confirm`, anything else aborts with nothing created). A failure
// leaves its typed record in `D/diagnostics/` (and, in human mode, the redacted report pair; the app
// writes its own pair for the recovery screen). Exit 0 done, 1 failed, 64 usage.
import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  buildRecoveryPrompt,
  classifyStartupError,
  homeRelativePath,
  type MigrateLine,
  migrateLineSchema,
  type PromptLang,
  RECOVERY_WORDS,
  type StartupFailure,
  StartupFailureError,
  startupFailure,
  startupFailureReport,
} from "@cashu/host-protocol/startup-failure";
import { createBackendI18n, createTranslator, type Translator } from "@cashu/i18n";
import {
  acquireHostLock,
  hostRunPaths,
  nodeLanguageSource,
  startupReportPaths,
  writeStartupFailureRecord,
  writeStartupFailureReport,
} from "@cashu/node-host";
import {
  completedMigration,
  type InPlaceKeychain,
  interruptedMigration,
  type InPlaceResult,
  type MigrationMarker,
  migrateInPlace,
  readMigrationMarker,
} from "./inPlace.js";
import { M, type MigrateCounts, type UnpricedLine } from "./migrate.strings.js";
import { type KeyStoreFactory, verifyPythonMigration } from "./oneShot.js";
import { unpricedAfterMigration } from "./priceReach.js";

/** Exit code of a malformed command line (EX_USAGE). */
const USAGE_EXIT = 64;

export interface MigrateIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
  /** One line of stdin without its newline; null at end of input. */
  readonly readLine: () => Promise<string | null>;
  /** The build id recorded with a failure. */
  readonly build: string;
  readonly now?: () => number;
  /** Synthetic test namespace only. */
  readonly keychain?: InPlaceKeychain;
  /** Tests: fault injection during the cutover. */
  readonly afterCutoverMove?: (moves: number) => void;
}

interface Args {
  readonly command: "import" | "verify";
  readonly dataDir: string;
  readonly recoveryFile?: string;
  readonly json: boolean;
}

/** The user typed something else than `cancel` / `confirm`, or input ended: nothing is created. */
class MigrationCancelled extends Error {
  readonly code = "cancelled";
  constructor() {
    super("cancelled");
    this.name = "MigrationCancelled";
  }
}

const canonicalPath = (value: string) =>
  isAbsolute(value) && resolve(value) === value && !value.includes("\0");

function inside(path: string, root: string): boolean {
  const nested = relative(root, path);
  return (
    nested === "" || (nested !== ".." && !nested.startsWith(`..${sep}`) && !isAbsolute(nested))
  );
}

function parse(argv: readonly string[], env: MigrateIo["env"]): Args | null {
  const command = argv[0] === "verify" ? "verify" : "import";
  const rest = command === "verify" ? argv.slice(1) : argv;
  let dataDir: string | undefined;
  let recoveryFile: string | undefined;
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (flag === "--json" && !json) {
      json = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) return null;
    if (flag === "--data-dir" && dataDir === undefined) dataDir = value;
    else if (flag === "--recovery-file" && recoveryFile === undefined) recoveryFile = value;
    else return null;
    i++;
  }
  dataDir ??= env.CASHU_DATA_DIR;
  if (dataDir === undefined || !canonicalPath(dataDir)) return null;
  if (recoveryFile !== undefined) {
    if (command === "verify" || json || !canonicalPath(recoveryFile)) return null;
    // A new file in an existing canonical directory outside the data dir.
    try {
      const realData = realpathSync(dataDir);
      if (realpathSync(dirname(recoveryFile)) !== dirname(recoveryFile)) return null;
      if (inside(recoveryFile, dataDir) || inside(recoveryFile, realData)) return null;
    } catch {
      return null;
    }
    try {
      lstatSync(recoveryFile);
      return null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
    }
  }
  return {
    command,
    dataDir,
    json,
    ...(recoveryFile === undefined ? {} : { recoveryFile }),
  };
}

/** Writes the words once to a new private file (O_EXCL, 0600) and fsyncs it and its directory. */
function saveWords(path: string, dataDir: string, words: string): void {
  if (realpathSync(dirname(path)) !== dirname(path) || inside(path, realpathSync(dataDir)))
    throw new Error("recovery_file_invalid");
  const fd = openSync(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const bytes = Buffer.from(`${words}\n`);
    for (let offset = 0; offset < bytes.length; ) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (written <= 0) throw new Error("recovery_file_invalid");
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  const dir = openSync(
    dirname(path),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    fsyncSync(dir);
  } finally {
    closeSync(dir);
  }
}

function isDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Leaves the typed failure record in `D/diagnostics/` and, unless the app writes its own
 * (`withReport` false), the redacted report pair. Best effort: returns the prompt file, or null.
 */
function recordMigrationFailure(
  dataDir: string,
  failure: StartupFailure,
  options: { lang: PromptLang; build: string; home: string; withReport: boolean; at?: Date },
): string | null {
  if (!isDirectory(dataDir)) return null;
  const at = options.at ?? new Date();
  try {
    writeStartupFailureRecord(dataDir, failure, options.build, at.valueOf());
    if (!options.withReport) return null;
    const paths = startupReportPaths(dataDir, at);
    const report = startupFailureReport({
      failure,
      at,
      appVersion: "",
      build: options.build,
      dataDir,
      home: options.home,
      reportFile: paths.text,
      logText: "",
    });
    writeStartupFailureReport(paths, report, buildRecoveryPrompt(report, options.lang));
    return paths.text;
  } catch {
    return null;
  }
}

/** One protocol line, checked against the schema before it leaves (never a free value). */
function emit(io: MigrateIo, line: MigrateLine): void {
  io.stdout(JSON.stringify(migrateLineSchema.parse(line)));
}

const countsOf = (marker: MigrateCounts): MigrateCounts => ({
  profiles: marker.profiles,
  financialTables: marker.financialTables,
  financialRows: marker.financialRows,
  vaults: marker.vaults,
});

/** Failures after which nothing needs recovering: no record, no report. */
const QUIET_DETAILS = new Set(["cancelled", "python_data_absent"]);

function reportFailure(
  io: MigrateIo,
  args: Args,
  t: Translator,
  home: string,
  failure: StartupFailure,
): number {
  const quiet = failure.detail !== undefined && QUIET_DETAILS.has(failure.detail);
  const report = quiet
    ? null
    : recordMigrationFailure(args.dataDir, failure, {
        lang: t.language,
        build: io.build,
        home,
        withReport: !args.json,
      });
  if (args.json) {
    emit(io, {
      event: "failed",
      code: failure.code,
      ...(failure.detail === undefined ? {} : { detail: failure.detail }),
    });
    return 1;
  }
  const detail = failure.detail ?? "";
  io.stderr(
    args.command === "verify"
      ? t.tr(M.verifyFailed)(failure.code, detail)
      : t.tr(M.failed)(failure.code, detail),
  );
  if (args.command === "import") {
    if (failure.code === "migration_incomplete") io.stderr(t.tr(M.incomplete));
    else if (failure.originalsUntouched) io.stderr(t.tr(M.originalsUntouched));
  }
  if (report !== null) io.stderr(t.tr(M.report)(homeRelativePath(report, home)));
  return 1;
}

async function runImport(io: MigrateIo, args: Args, t: Translator, home: string): Promise<number> {
  let wordsFile: string | undefined;
  let result: InPlaceResult;
  try {
    result = await migrateInPlace({
      dataDir: args.dataDir,
      at: io.now?.() ?? Date.now(),
      onProgress(stage) {
        if (args.json) emit(io, { event: "progress", stage });
        else io.stdout(t.tr(M.stage)(stage));
      },
      async saveRecoveryWords(words) {
        if (!RECOVERY_WORDS.test(words)) throw new Error("identity_invalid");
        if (!args.json) {
          const file = args.recoveryFile;
          if (file === undefined) throw new Error("recovery_file_invalid");
          saveWords(file, args.dataDir, words);
          wordsFile = file;
          io.stdout(t.tr(M.wordsSaved)(homeRelativePath(file, home)));
          return;
        }
        emit(io, { event: "recovery-words", words });
        if ((await io.readLine()) !== "confirm") throw new MigrationCancelled();
      },
      ...(io.keychain === undefined ? {} : { keychain: io.keychain }),
      ...(io.afterCutoverMove === undefined ? {} : { afterCutoverMove: io.afterCutoverMove }),
    });
  } catch (error) {
    // Words of an identity that no longer exists would only mislead: remove the file we created,
    // unless the cutover started (then its vaults are real and the words are theirs).
    const incomplete =
      error instanceof StartupFailureError && error.failure.code === "migration_incomplete";
    if (wordsFile !== undefined && !incomplete) rmSync(wordsFile, { force: true });
    throw error;
  }
  const { marker } = result;
  if (result.status === "already_migrated" && !args.json) {
    printAlreadyMigrated(io, args, t, home, marker);
    return 0;
  }
  const backup = homeRelativePath(join(args.dataDir, marker.backupDir), home);
  if (args.json) {
    emit(io, {
      event: "done",
      status: result.status,
      ...countsOf(marker),
      backupDir: marker.backupDir,
    });
    return 0;
  }
  io.stdout(t.tr(M.migrated)(countsOf(marker), backup));
  printUnpriced(io, t, args.dataDir, marker.backupDir, false);
  io.stdout(t.tr(M.verifyHint));
  return 0;
}

/**
 * Names every imported instrument the app cannot price (human mode), instead of a silent 0. After a
 * finished cutover a failing check must not turn the import into a reported failure (`strict`
 * false: the verify that the hint asks for runs it strictly).
 */
function printUnpriced(
  io: MigrateIo,
  t: Translator,
  dataDir: string,
  backupDir: string,
  strict: boolean,
): void {
  let unpriced: readonly UnpricedLine[];
  try {
    unpriced = unpricedAfterMigration(dataDir, backupDir);
  } catch (error) {
    if (strict) throw error;
    return;
  }
  if (unpriced.length > 0) io.stdout(t.tr(M.unpriced)(unpriced));
}

function printAlreadyMigrated(
  io: MigrateIo,
  args: Args,
  t: Translator,
  home: string,
  marker: MigrationMarker,
): void {
  const backup = homeRelativePath(join(args.dataDir, marker.backupDir), home);
  io.stdout(t.tr(M.alreadyMigrated)(new Date(marker.at).toISOString(), backup));
  io.stdout(t.tr(M.verifyHint));
}

/** D's marker when D was already migrated in place; null for anything else (read-only). */
function completedOrNull(dataDir: string): MigrationMarker | null {
  try {
    return completedMigration(dataDir);
  } catch {
    return null;
  }
}

/** D holds an interrupted cutover's journal; false for anything else (read-only). */
function interruptedOrFalse(dataDir: string): boolean {
  try {
    return interruptedMigration(dataDir);
  } catch {
    return false;
  }
}

async function runVerify(io: MigrateIo, args: Args, t: Translator, home: string): Promise<number> {
  const marker = readMigrationMarker(args.dataDir);
  if (marker === null) throw new Error("python_data_absent");
  // A running host holds D's lock; verification reopens the vaults and needs it free.
  const lock = acquireHostLock(hostRunPaths(args.dataDir).lockPath);
  if (!lock) throw new Error("native_host_lock_required");
  lock.release();
  const backup = join(args.dataDir, marker.backupDir);
  const makeKeyStore: KeyStoreFactory | undefined = io.keychain?.makeKeyStore;
  const verified = await verifyPythonMigration({
    sourceDir: backup,
    targetDir: args.dataDir,
    at: marker.at,
    ...(makeKeyStore === undefined ? {} : { makeKeyStore }),
  });
  const counts: MigrateCounts = {
    profiles: verified.profiles,
    financialTables: verified.financialTables,
    financialRows: verified.financialRows,
    vaults: verified.vaults.length,
  };
  if (JSON.stringify(counts) !== JSON.stringify(countsOf(marker)))
    throw new Error("replay_mismatch");
  if (args.json)
    emit(io, { event: "done", status: "verified", ...counts, backupDir: marker.backupDir });
  else {
    io.stdout(t.tr(M.verified)(counts, homeRelativePath(backup, home)));
    printUnpriced(io, t, args.dataDir, marker.backupDir, true);
  }
  return 0;
}

/** `migrate ...` (argv after the command word). Resolves with the exit code. */
export async function migrateCommand(argv: readonly string[], io: MigrateIo): Promise<number> {
  const args = parse(argv, io.env);
  const t = createTranslator(
    createBackendI18n(nodeLanguageSource({ env: io.env, dataDir: args?.dataDir })).appLanguage(),
  );
  if (args === null) {
    io.stderr(t.tr(M.usage));
    return USAGE_EXIT;
  }
  const home = io.env.HOME || homedir();
  // The words go only to a new --recovery-file; without one, only a finished import can be shown
  // or an interrupted cutover finished (it never asks for words).
  if (
    args.command === "import" &&
    !args.json &&
    args.recoveryFile === undefined &&
    !interruptedOrFalse(args.dataDir)
  ) {
    const marker = completedOrNull(args.dataDir);
    if (marker === null) {
      io.stderr(t.tr(M.usage));
      return USAGE_EXIT;
    }
    printAlreadyMigrated(io, args, t, home, marker);
    return 0;
  }
  try {
    return args.command === "import"
      ? await runImport(io, args, t, home)
      : await runVerify(io, args, t, home);
  } catch (error) {
    let failure = classifyStartupError(
      error,
      {},
      args.command === "verify" ? "migrate_verify_mismatch" : "migrate_import_failed",
    );
    // `verify` reads what the import left; a refusal of that state is a verification failure.
    if (args.command === "verify" && failure.code === "migrate_import_failed")
      failure = startupFailure("migrate_verify_mismatch", failure.detail);
    return reportFailure(io, args, t, home, failure);
  }
}
