// Allow-list redaction for the recovery report. The report may be pasted into a cloud LLM, so it
// carries only enum codes, integer counts, booleans, the app version, a shortened build id and paths
// relative to the home folder. Free text from errors or logs never passes: a log line is parsed and
// only its level, a known event name, a known failure code / detail and a known error class survive.
import {
  STARTUP_FAILURE_CODES,
  STARTUP_FAILURE_DETAIL_NAMES,
  type StartupFailureCode,
  type StartupFailureDetail,
} from "./codes.js";

/** Shown instead of a path outside the home folder (it may name another user or a mount). */
export const OUTSIDE_HOME = "<outside home>";
/** Shown instead of one path component that is not plain ASCII text. */
const HIDDEN_COMPONENT = "<...>";
/** Shown instead of a version or build id that does not have the expected shape. */
const UNKNOWN_BUILD = "<unknown>";

const COMPONENT = /^[A-Za-z0-9 ._()-]{1,64}$/;

/**
 * `path` as `~` or `~/...` when it lies inside `home`, else `<outside home>`. Both must be absolute
 * POSIX paths; a component that is not plain ASCII (or is `.` / `..`) becomes `<...>`.
 */
export function homeRelativePath(path: string, home: string): string {
  const trimmedHome = home.replace(/\/+$/, "");
  if (!path.startsWith("/") || !trimmedHome.startsWith("/") || trimmedHome === "")
    return OUTSIDE_HOME;
  const parts = path.split("/").filter((part) => part !== "");
  const homeParts = trimmedHome.split("/").filter((part) => part !== "");
  if (parts.some((part) => part === "." || part === "..")) return OUTSIDE_HOME;
  if (homeParts.length === 0 || parts.length < homeParts.length) return OUTSIDE_HOME;
  for (let i = 0; i < homeParts.length; i++) if (parts[i] !== homeParts[i]) return OUTSIDE_HOME;
  const rest = parts
    .slice(homeParts.length)
    .map((part) => (COMPONENT.test(part) ? part : HIDDEN_COMPONENT));
  return rest.length === 0 ? "~" : `~/${rest.join("/")}`;
}

/** A displayed path is `~`, `~/...` of plain components, or one of the placeholders. */
export const DISPLAY_PATH = /^(?:~(?:\/(?:[A-Za-z0-9 ._()-]{1,64}|<\.\.\.>))*|<outside home>)$/;

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?$/;

/** The app version, or `<unknown>` when it is not a plain semantic version. */
export function appVersionLabel(version: string): string {
  return VERSION.test(version) ? version : UNKNOWN_BUILD;
}

/**
 * The build id for display: a packaged id (`desktop-<version>-<64 hex digest>`) keeps its version and
 * the first 12 digest characters; a short lowercase dev id stays; anything else is `<unknown>`.
 */
export function buildLabel(build: string): string {
  const packaged =
    /^desktop-(\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?)-([a-f0-9]{64})$/.exec(build);
  if (packaged) return `desktop-${packaged[1]}-${packaged[2]?.slice(0, 12)}`;
  return /^[a-z][a-z-]{0,23}$/.test(build) ? build : UNKNOWN_BUILD;
}

export const BUILD_LABEL =
  /^(?:desktop-\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?-[a-f0-9]{12}|[a-z][a-z-]{0,23}|<unknown>)$/;
export const VERSION_LABEL = /^(?:\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z.-]{1,32})?|<unknown>)$/;

/** Host log events that may appear in the tail (apps/host log.ts JSON lines and vault diagnostics). */
export const LOG_EVENTS = [
  "admin.handover",
  "admin.stop",
  "cli.exec",
  "cli.exec-failed",
  "device.recovered",
  "host.bundle-replaced",
  "host.lan-unavailable",
  "host.launcher-failed",
  "host.launcher-written",
  "host.safe-mode",
  "host.start-failed",
  "host.start-failure",
  "host.started",
  "host.stopped",
  "host.stopping",
  "mcp.open",
  "mcp.server-exit",
  "mcp.unavailable",
  "native_carrier_request_failed",
  "native_device_commit_append_unknown",
  "native_device_commit_recovery_failed",
  "native_lease_append_unknown",
  "native_lease_inspect_unknown",
  "native_lease_reconcile_failed",
  "native_pairing_append_unknown",
  "native_revoke_reconcile_unknown",
  "native_strategy_directory_unavailable",
  "native_sync_failed",
  "native_sync_listener_failed",
  "store.action.failed",
  "store.command.failed",
  "store.invalid-message",
  "store.query.failed",
  "worker.binding-failed",
] as const;
type LogEvent = (typeof LOG_EVENTS)[number];

/** Error class names a log line may name (log.ts writes the class name, never the message). */
export const LOG_ERROR_CLASSES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "AbortError",
  "StartupFailureError",
  "MigrationError",
  "HostBusyError",
  "HostConnectError",
  "HostStartError",
  "HostPathError",
  "RefusalError",
  "UpdateAdmissionError",
] as const;
type LogErrorClass = (typeof LOG_ERROR_CLASSES)[number];

export const LOG_LEVELS = ["info", "warn", "error"] as const;
type LogLevelName = (typeof LOG_LEVELS)[number];

/** One sanitized log line: every field is from a closed list (the time is an exact ISO instant). */
export interface SanitizedLogLine {
  readonly at: string | null;
  readonly level: LogLevelName;
  readonly event: LogEvent;
  readonly code?: StartupFailureCode;
  readonly detail?: StartupFailureDetail;
  readonly error?: LogErrorClass;
}

export interface SanitizedLogTail {
  readonly lines: readonly SanitizedLogLine[];
  /** Lines of the scanned window that did not pass the allow-list (counted, never shown). */
  readonly omitted: number;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const MAX_LINE = 2048;

function member<T extends string>(list: readonly T[], value: unknown): T | undefined {
  return typeof value === "string" && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function fromJson(line: string): SanitizedLogLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const fields = parsed as Record<string, unknown>;
  const level = member(LOG_LEVELS, fields.level);
  const event = member(LOG_EVENTS, fields.event);
  if (level === undefined || event === undefined) return null;
  const code = member(STARTUP_FAILURE_CODES, fields.code);
  const detail = member(STARTUP_FAILURE_DETAIL_NAMES, fields.detail);
  const error = member(LOG_ERROR_CLASSES, fields.error);
  return {
    at: typeof fields.at === "string" && ISO.test(fields.at) ? fields.at : null,
    level,
    event,
    ...(code === undefined ? {} : { code }),
    ...(detail === undefined ? {} : { detail }),
    ...(error === undefined ? {} : { error }),
  };
}

/** `event ErrorClass [code]`: what the vault diagnostics write to stderr (nativeVault/diagnostics.ts). */
function fromDiagnostic(line: string): SanitizedLogLine | null {
  const tokens = line.split(" ");
  if (tokens.length < 2 || tokens.length > 3) return null;
  const event = member(LOG_EVENTS, tokens[0]);
  const error = member(LOG_ERROR_CLASSES, tokens[1]);
  if (event === undefined || error === undefined) return null;
  const detail =
    tokens[2] === undefined ? undefined : member(STARTUP_FAILURE_DETAIL_NAMES, tokens[2]);
  if (tokens[2] !== undefined && tokens[2] !== "?" && detail === undefined) return null;
  return { at: null, level: "warn", event, error, ...(detail === undefined ? {} : { detail }) };
}

/**
 * The last `max` allow-listed lines of a host log text (the caller reads only the file's tail). A
 * line that is too long, is not a known JSON event or vault diagnostic, or names an unknown event
 * is counted as omitted; its text never leaves this function.
 */
export function sanitizeLogTail(text: string, max = 20): SanitizedLogTail {
  const lines: SanitizedLogLine[] = [];
  let omitted = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    const kept =
      line.length > MAX_LINE ? null : line.startsWith("{") ? fromJson(line) : fromDiagnostic(line);
    if (kept === null) omitted += 1;
    else lines.push(kept);
  }
  const extra = Math.max(0, lines.length - max);
  return { lines: lines.slice(extra), omitted: omitted + extra };
}

/** One sanitized line as text: `at level event code=... detail=... error=...`. */
export function formatLogLine(line: SanitizedLogLine): string {
  return [
    line.at ?? "-",
    line.level,
    line.event,
    ...(line.code === undefined ? [] : [`code=${line.code}`]),
    ...(line.detail === undefined ? [] : [`detail=${line.detail}`]),
    ...(line.error === undefined ? [] : [`error=${line.error}`]),
  ].join(" ");
}
