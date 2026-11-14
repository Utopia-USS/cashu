// Start-up failure files in `<data dir>/diagnostics/` (0700; files 0600, written atomically):
//   startup-failure.json             the latest failure record, written by the host (or the
//                                    migration CLI) before it exits; read by Electron main
//   startup-failure-<time>.json/.txt one report per failure shown: the validated report and the
//                                    agent prompt built from it (already redacted)
// Reads are bounded and refuse links and foreign files: the record crosses a process boundary, so
// whatever does not parse exactly is reported as an `unknown` failure, never trusted.
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  DIAGNOSTICS_DIR,
  MAX_FAILURE_FILE_BYTES,
  parseStartupFailureRecord,
  STARTUP_FAILURE_RECORD,
  type StartupFailure,
  type StartupFailureRecord,
  type StartupFailureReport,
  startupFailure,
} from "@cashu/host-protocol/startup-failure";
import { ensurePrivateDir } from "./paths.js";

/** Bytes of the host log's end read for the sanitized tail. */
const LOG_TAIL_BYTES = 64 * 1024;

function writePrivateAtomic(path: string, text: string): void {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx", flush: true });
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** The private diagnostics directory of a data dir (created 0700 when missing). */
export function diagnosticsDir(dataDir: string): string {
  const dir = join(dataDir, DIAGNOSTICS_DIR);
  ensurePrivateDir(dir);
  return dir;
}

/** Writes the latest failure record (the host's last act before it exits on a failed start). */
export function writeStartupFailureRecord(
  dataDir: string,
  failure: StartupFailure,
  build: string,
  now: number = Date.now(),
): void {
  diagnosticsDir(dataDir);
  const record: StartupFailureRecord = {
    format: 1,
    failure,
    at: now,
    build: /^[A-Za-z0-9._+-]{1,128}$/.test(build) ? build : "unknown",
  };
  writePrivateAtomic(join(dataDir, STARTUP_FAILURE_RECORD), `${JSON.stringify(record)}\n`);
}

/**
 * Up to `max` bytes from the end of a regular file of this user (no link), or null when it is
 * missing or not such a file.
 */
function readTail(path: string, max: number): { text: string; mtimeMs: number } | null {
  let fd: number;
  try {
    const link = lstatSync(path);
    if (!link.isFile() || link.isSymbolicLink()) return null;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (typeof process.getuid === "function" && stat.uid !== process.getuid()))
      return null;
    const length = Math.min(stat.size, max);
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, stat.size - length + read);
      if (n <= 0) break;
      read += n;
    }
    return { text: buffer.subarray(0, read).toString("utf8"), mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export interface FoundStartupFailure {
  readonly failure: StartupFailure;
  readonly at: number;
  readonly build: string | null;
}

/**
 * The failure record written at or after `since` (ms), or null when there is none that fresh. A
 * fresh file that is too large or does not parse exactly is an `unknown` failure.
 */
export function readStartupFailureRecord(
  dataDir: string,
  since: number,
): FoundStartupFailure | null {
  const file = readTail(join(dataDir, STARTUP_FAILURE_RECORD), MAX_FAILURE_FILE_BYTES + 1);
  if (file === null) return null;
  let record: StartupFailureRecord | null = null;
  if (file.text.length <= MAX_FAILURE_FILE_BYTES) {
    try {
      record = parseStartupFailureRecord(JSON.parse(file.text));
    } catch {
      record = null;
    }
  }
  if (record !== null)
    return record.at >= since
      ? { failure: record.failure as StartupFailure, at: record.at, build: record.build }
      : null;
  return file.mtimeMs >= since
    ? { failure: startupFailure("unknown"), at: Math.trunc(file.mtimeMs), build: null }
    : null;
}

/** The end of the host log (`<data dir>/logs/host.log`) as raw text, for `sanitizeLogTail`. */
export function readHostLogTail(logPath: string): string {
  const tail = readTail(logPath, LOG_TAIL_BYTES)?.text ?? "";
  // The first line of a tail window is usually cut; drop it.
  const cut = tail.length === LOG_TAIL_BYTES ? tail.indexOf("\n") + 1 : 0;
  return tail.slice(cut);
}

export interface StartupReportPaths {
  /** The agent prompt (already redacted). */
  readonly text: string;
  /** The validated report it was built from. */
  readonly json: string;
}

/**
 * Free paths for one report pair: `startup-failure-<time>.txt` / `.json` (a numeric suffix when that
 * name is taken). Nothing is ever overwritten or deleted.
 */
export function startupReportPaths(dataDir: string, at: Date): StartupReportPaths {
  const dir = diagnosticsDir(dataDir);
  const stem = `startup-failure-${at.toISOString().replace(/[-:.]/g, "")}`;
  for (let n = 0; n < 100; n++) {
    const name = n === 0 ? stem : `${stem}-${n}`;
    const paths = { text: join(dir, `${name}.txt`), json: join(dir, `${name}.json`) };
    if (!exists(paths.text) && !exists(paths.json)) return paths;
  }
  throw new Error("startup_failure_report_unavailable");
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** Writes one report pair at paths from `startupReportPaths`. */
export function writeStartupFailureReport(
  paths: StartupReportPaths,
  report: StartupFailureReport,
  prompt: string,
): void {
  writePrivateAtomic(paths.json, `${JSON.stringify(report, null, 2)}\n`);
  writePrivateAtomic(paths.text, prompt);
}
