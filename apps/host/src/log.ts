// The host's structured local log: one JSON object per line in `<data dir>/logs/host.log` (0600; the
// detached spawn sends stray stdout / stderr to the same file). It never carries data values: fields
// are counts, flags and short codes (event names, command / query ids, error class names), and a
// string that does not look like a code is replaced by "?". Errors are logged by class name only:
// a message may quote a value. The file rotates once it passes 5 MB (one old copy, host.log.1).
import { appendFileSync, chmodSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { ensurePrivateDir } from "@cashu/node-host";

export type LogLevel = "info" | "warn" | "error";
export type LogField = number | boolean | string | null;

export interface HostLog {
  info(event: string, fields?: Readonly<Record<string, LogField>>): void;
  warn(event: string, fields?: Readonly<Record<string, LogField>>): void;
  error(event: string, fields?: Readonly<Record<string, LogField>>): void;
}

const CODE = /^[A-Za-z0-9_.:/-]{0,64}$/;
const ROTATE_BYTES = 5 * 1024 * 1024;

/** A log field's safe form: numbers and flags as they are, strings only when they look like a code. */
function safe(value: LogField): LogField {
  if (typeof value === "string") return CODE.test(value) ? value : "?";
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  return value;
}

/** The class name of a thrown value, for a log field. */
export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** One log line (exported for tests). */
export function formatLine(
  at: Date,
  level: LogLevel,
  event: string,
  fields: Readonly<Record<string, LogField>> = {},
): string {
  const line: Record<string, LogField> = { at: at.toISOString(), level, event: safe(event) };
  for (const [key, value] of Object.entries(fields)) {
    if (CODE.test(key) && !(key in line)) line[key] = safe(value);
  }
  return `${JSON.stringify(line)}\n`;
}

/** A log appending to `path` (rotated at start when it is large). */
export function fileLog(path: string, now: () => Date = () => new Date()): HostLog {
  ensurePrivateDir(dirname(path));
  try {
    if (statSync(path).size > ROTATE_BYTES) renameSync(path, `${path}.1`);
  } catch {
    // no log yet
  }
  let created = false;
  const write = (level: LogLevel, event: string, fields?: Readonly<Record<string, LogField>>) => {
    try {
      appendFileSync(path, formatLine(now(), level, event, fields), { mode: 0o600 });
      if (!created) {
        created = true;
        chmodSync(path, 0o600);
      }
    } catch {
      // A full disk must not take the host down; the log is best effort.
    }
  };
  return {
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
  };
}

/** A log that keeps its lines in memory (tests). */
export function memoryLog(): HostLog & { readonly lines: string[] } {
  const lines: string[] = [];
  const at = new Date(0);
  return {
    lines,
    info: (event, fields) => lines.push(formatLine(at, "info", event, fields)),
    warn: (event, fields) => lines.push(formatLine(at, "warn", event, fields)),
    error: (event, fields) => lines.push(formatLine(at, "error", event, fields)),
  };
}
