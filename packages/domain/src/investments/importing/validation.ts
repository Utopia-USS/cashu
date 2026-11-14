/**
 * File validation without a database: parse an import file and report every problem.
 *
 * `validateImport` checks a file with an importer (default: the canonical `cashu-import` importer, CSV
 * or JSON, see `docs/import-format.md`). Reading the file or the mapping YAML is the caller's job (the
 * domain does no I/O): `validateImportFile` takes the bytes with their size guard.
 */

import { CanonicalImporter } from "./canonical/index.js";
import {
  type BrokerImporter,
  blockingWarning,
  type ImportFile,
  type ImportParseResult,
  type ImportWarning,
  ImportWarningKind,
  instrumentNamed,
  warningKey,
  warningText,
} from "./contract.js";
import { safeCanParse } from "./registry.js";
import { semanticIssues } from "./semantic.js";

/** Largest file the validator reads (a real export is far smaller). */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** Outcome of validating one file. */
export interface ValidationReport {
  readonly fileName: string;
  /** Broker id of the importer that parsed the file; null when none could. */
  readonly importerId: string | null;
  /** Blocking problems: the file cannot be imported until they are fixed. */
  readonly errors: readonly ImportWarning[];
  /** Suspicious but importable rows. */
  readonly warnings: readonly ImportWarning[];
  readonly result: ImportParseResult | null;
}

export function reportOk(report: ValidationReport): boolean {
  return report.importerId !== null && report.errors.length === 0;
}

export function reportTxnCount(report: ValidationReport): number {
  return report.result?.txns.length ?? 0;
}

export function reportPositionCount(report: ValidationReport): number {
  return report.result?.positions.length ?? 0;
}

export function reportCorporateActionCount(report: ValidationReport): number {
  return report.result?.corporateActions.length ?? 0;
}

/** `ValidationReport.summary`: human-readable report: verdict, counts, then every error and warning. */
export function reportSummary(report: ValidationReport): string {
  const verdict = reportOk(report) ? "OK" : "INVALID";
  const lines = [
    `${report.fileName}: ${verdict} (${report.importerId ?? "no importer"})`,
    `  transactions: ${reportTxnCount(report)}, positions: ${reportPositionCount(report)}, corporate actions: ${reportCorporateActionCount(report)}`,
    `  errors: ${report.errors.length}, warnings: ${report.warnings.length}`,
    ...report.errors.map((issue) => `  error   ${warningText(issue)}`),
    ...report.warnings.map((issue) => `  warning ${warningText(issue)}`),
  ];
  return lines.join("\n");
}

function failedReport(fileName: string, error: ImportWarning): ValidationReport {
  return { fileName, importerId: null, errors: [error], warnings: [], result: null };
}

function dedupe(issues: readonly ImportWarning[]): ImportWarning[] {
  const seen = new Set<string>();
  const unique: ImportWarning[] = [];
  for (const issue of issues) {
    const key = warningKey(issue);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(issue);
    }
  }
  return unique;
}

/** Validate `file` with `importer` (default: the canonical importer). */
export function validateImport(
  file: ImportFile,
  importer: BrokerImporter = new CanonicalImporter(),
): ValidationReport {
  if (!safeCanParse(importer, file)) {
    const hint =
      importer instanceof CanonicalImporter
        ? "expected a cashu-import CSV (header with format_version and record columns) or JSON (object with format cashU-import); see docs/import-format.md"
        : "the mapped columns or the extension do not match the file";
    return failedReport(
      file.name,
      blockingWarning(
        null,
        `Not recognized by the ${importer.brokerId} importer: ${hint}`,
        ImportWarningKind.IMPORTER_ERROR,
      ),
    );
  }
  let result: ImportParseResult;
  try {
    result = importer.parse(file);
  } catch (error) {
    // An importer bug is reported, never thrown.
    const reason = error instanceof Error ? error.message : String(error);
    return failedReport(
      file.name,
      blockingWarning(
        null,
        `Importer ${importer.brokerId} failed: ${reason}`,
        ImportWarningKind.IMPORTER_ERROR,
      ),
    );
  }
  const errors = result.warnings.filter((warning) => warning.blocking);
  const warnings = result.warnings.filter((warning) => !warning.blocking);
  for (const txn of result.txns) errors.push(...semanticIssues(txn, instrumentNamed(txn)));
  return {
    fileName: file.name,
    importerId: importer.brokerId,
    errors: dedupe(errors),
    warnings,
    result,
  };
}

/**
 * `validate_import_file` for a file the caller has read: a file over `maxBytes` is refused unread,
 * otherwise `validateImport`. A mapping YAML (generic CSV) becomes an `importer` on the caller's side.
 */
export function validateImportFile(
  file: ImportFile,
  importer?: BrokerImporter,
  maxBytes: number = MAX_FILE_BYTES,
): ValidationReport {
  const size = file.content.byteLength;
  if (size > maxBytes) {
    return failedReport(
      file.name,
      blockingWarning(
        null,
        `File is too large (${size} bytes, max ${maxBytes})`,
        ImportWarningKind.FILE_FORMAT,
      ),
    );
  }
  return validateImport(file, importer);
}
