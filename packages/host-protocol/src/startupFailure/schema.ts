// Wire forms of a start-up failure: the record the host writes to
// `<data dir>/diagnostics/startup-failure.json`, and the report Electron main hands to the renderer
// and writes beside it. Both are strict: an unknown field, a free string or a fractional count fails
// the parse, and the reader then treats the failure as `unknown`.
import { z } from "zod";
import {
  STARTUP_FACT_KEYS,
  STARTUP_FAILURE_CODES,
  STARTUP_FAILURE_DETAIL_NAMES,
  STARTUP_STAGES,
  type StartupFailure,
  type StartupFailureDetail,
} from "./codes.js";
import { type RecoveryCommand, recoveryCommandSchema } from "./command.js";
import {
  BUILD_LABEL,
  DISPLAY_PATH,
  LOG_ERROR_CLASSES,
  LOG_EVENTS,
  LOG_LEVELS,
  type SanitizedLogLine,
  VERSION_LABEL,
} from "./redaction.js";

/** A flavor's MCP server name prefix: lowercase words joined by hyphens. */
const MCP_SERVER_PREFIX = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Where the host keeps its latest failure record, relative to the data dir. */
export const STARTUP_FAILURE_RECORD = "diagnostics/startup-failure.json";
/** The directory of every diagnostics file, relative to the data dir. */
export const DIAGNOSTICS_DIR = "diagnostics";
/** Upper bound for reading a record or a report file. */
export const MAX_FAILURE_FILE_BYTES = 16 * 1024;

const count = z.number().int().min(0).max(1_000_000);
const detail = z.enum(
  STARTUP_FAILURE_DETAIL_NAMES as [StartupFailureDetail, ...StartupFailureDetail[]],
);

const startupFactsSchema = z.strictObject(
  Object.fromEntries(STARTUP_FACT_KEYS.map((key) => [key, count.optional()])) as Record<
    (typeof STARTUP_FACT_KEYS)[number],
    z.ZodOptional<typeof count>
  >,
);

const startupFailureSchema = z.strictObject({
  code: z.enum(STARTUP_FAILURE_CODES),
  stage: z.enum(STARTUP_STAGES),
  detail: detail.optional(),
  originalsUntouched: z.boolean(),
  facts: startupFactsSchema,
});

/** What the host writes before it exits on a failed start. */
export const startupFailureRecordSchema = z.strictObject({
  format: z.literal(1),
  failure: startupFailureSchema,
  /** Milliseconds since the epoch; a reader ignores a record older than its own start attempt. */
  at: z.number().int().min(0),
  build: z.string().regex(/^[A-Za-z0-9._+-]{1,128}$/),
});
export type StartupFailureRecord = z.infer<typeof startupFailureRecordSchema>;

const sanitizedLogLineSchema = z.strictObject({
  at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    .nullable(),
  level: z.enum(LOG_LEVELS),
  event: z.enum(LOG_EVENTS),
  code: z.enum(STARTUP_FAILURE_CODES).optional(),
  detail: detail.optional(),
  error: z.enum(LOG_ERROR_CLASSES).optional(),
});

const displayPath = z.string().max(512).regex(DISPLAY_PATH);

/** What Electron main shows and writes: the failure plus allow-listed context. */
export const startupFailureReportSchema = z.strictObject({
  format: z.literal(1),
  failure: startupFailureSchema,
  /** When the failure was recorded (ISO instant). */
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  appVersion: z.string().regex(VERSION_LABEL),
  build: z.string().regex(BUILD_LABEL),
  dataDir: displayPath,
  /** The diagnostics text file holding this report, once written. */
  reportFile: displayPath.nullable(),
  logTail: z.array(sanitizedLogLineSchema).max(50),
  omittedLogLines: count,
  /** The `cashu` command form of this install (null: plain `cashu`). */
  command: recoveryCommandSchema.nullable(),
  /** The app flavor's MCP server name prefix (`cashu`, `cashu-staging`): `<prefix>-<slug>`. */
  mcpServerPrefix: z.string().regex(MCP_SERVER_PREFIX),
});

export interface StartupFailureReport {
  readonly format: 1;
  readonly failure: StartupFailure;
  readonly at: string;
  readonly appVersion: string;
  readonly build: string;
  readonly dataDir: string;
  readonly reportFile: string | null;
  readonly logTail: readonly SanitizedLogLine[];
  readonly omittedLogLines: number;
  readonly command: RecoveryCommand | null;
  readonly mcpServerPrefix: string;
}

/** Parses an untrusted report (IPC, a file); null when it does not match exactly. */
export function parseStartupFailureReport(value: unknown): StartupFailureReport | null {
  const parsed = startupFailureReportSchema.safeParse(value);
  return parsed.success ? (parsed.data as StartupFailureReport) : null;
}

/** Parses an untrusted failure record; null when it does not match exactly. */
export function parseStartupFailureRecord(value: unknown): StartupFailureRecord | null {
  const parsed = startupFailureRecordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
