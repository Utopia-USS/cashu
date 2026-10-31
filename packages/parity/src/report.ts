import type { Diff } from "./compare.ts";
import type { CheckReport, Report } from "./run.ts";

function describe(diff: Diff): string {
  return diff.detail === undefined
    ? `${diff.kind} at ${diff.path}`
    : `${diff.kind} (${diff.detail}) at ${diff.path}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function rowsCell(c: CheckReport): string {
  const golden = c.goldenRows === null ? "-" : String(c.goldenRows);
  const actual = c.actualRows === null ? "-" : String(c.actualRows);
  return c.actualRows === null || c.actualRows === c.goldenRows ? golden : `${golden}/${actual}`;
}

/** A plain-text table: check, status, rows, short hashes, first difference (path only). */
export function formatReport(report: Report, title?: string): string {
  const header = ["check", "status", "rows", "golden", "actual", "first difference"];
  const body = report.checks.map((c) => [
    c.check,
    c.status,
    rowsCell(c),
    c.goldenSha.slice(0, 12),
    c.actualSha === null ? "-" : c.actualSha.slice(0, 12),
    c.diff === undefined ? "" : describe(c.diff),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) =>
    cells
      .map((cell, i) => pad(cell, widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  const lines: string[] = [];
  if (title !== undefined) lines.push(title);
  lines.push(line(header), ...body.map(line));
  if (report.extra.length > 0) {
    lines.push(`note: ${report.extra.length} actual file(s) are not golden checks (ignored)`);
  }
  const { pass, fail, missing } = report.counts;
  lines.push(`${report.checks.length} checks: ${pass} pass, ${fail} fail, ${missing} missing`);
  return `${lines.join("\n")}\n`;
}

/** The report as JSON (full hashes, plus the staleness guard's result when given). Paths and counts only. */
export function reportToJson(report: Report & { readonly staleness?: unknown }): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
