// Assembles a report from a classified failure and raw context. Every raw input (the app version,
// the build id, absolute paths, the host log text) goes through its allow-list here, and the result
// is parsed with the report schema before anyone renders it.
import { countFacts, type StartupFailure, startupFailure } from "./codes.js";
import type { RecoveryCommand } from "./command.js";
import { appVersionLabel, buildLabel, homeRelativePath, sanitizeLogTail } from "./redaction.js";
import { parseStartupFailureReport, type StartupFailureReport } from "./schema.js";

export interface StartupFailureContext {
  readonly failure: StartupFailure;
  /** When the failure was recorded. */
  readonly at: Date;
  readonly appVersion: string;
  readonly build: string;
  /** Absolute paths, shown relative to `home` (else as a placeholder). */
  readonly dataDir: string;
  readonly home: string;
  readonly reportFile: string | null;
  /** The tail of the host log as read from disk; only allow-listed lines survive. */
  readonly logText: string;
  /** The `cashu` command form to show (`recoveryCommand`); absent or null: plain `cashu`. */
  readonly command?: RecoveryCommand | null;
}

export function startupFailureReport(context: StartupFailureContext): StartupFailureReport {
  const tail = sanitizeLogTail(context.logText);
  // Rebuild the failure from its codes: a caller-built object with extra fields never passes.
  const failure = startupFailure(
    context.failure.code,
    context.failure.detail,
    countFacts(context.failure.facts),
  );
  const at = Number.isFinite(context.at.valueOf()) ? context.at : new Date(0);
  const report = parseStartupFailureReport({
    format: 1,
    failure,
    at: at.toISOString(),
    appVersion: appVersionLabel(context.appVersion),
    build: buildLabel(context.build),
    dataDir: homeRelativePath(context.dataDir, context.home),
    reportFile:
      context.reportFile === null ? null : homeRelativePath(context.reportFile, context.home),
    logTail: tail.lines,
    omittedLogLines: Math.min(tail.omitted, 1_000_000),
    command: context.command ?? null,
  });
  if (report === null) throw new Error("startup_failure_report_invalid");
  return report;
}
