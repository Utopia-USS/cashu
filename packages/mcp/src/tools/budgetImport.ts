// A host port authorizes and reads the file; the validator itself is the pure S07 domain parser.
import { budget, core } from "@cashu/domain";
import * as L from "../privacy/labels.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";

export function validateBudgetImport(
  ctx: ToolContext<NativeToolStore>,
  args: ToolArgs,
): L.LabelledTree {
  const read = ctx.store.readBudgetImportFile;
  if (read === undefined)
    throw new ToolError("local file validation is unavailable", "unsupported");
  const file = read(typeof args.path === "string" ? args.path : "");
  const report = budget.validateBudgetDocument(
    file.bytes,
    file.name,
    core.builtinRegistry().institutions,
  );
  const counts = new Map<string, number>();
  for (const issue of report.issues) counts.set(issue.kind, (counts.get(issue.kind) ?? 0) + 1);
  return {
    ok: L.flag(report.ok),
    variant: L.category(report.variant),
    transactions: L.count(report.transactionCount),
    balances: L.count(report.closingCount),
    date_from: L.date(report.dateRange?.[0] ?? null),
    date_to: L.date(report.dateRange?.[1] ?? null),
    currencies: report.currencies.map(L.category),
    issues_by_kind: Object.fromEntries(
      [...counts]
        .sort(([a], [b]) => budget.codePointCompare(a, b))
        .map(([kind, count]) => [kind, L.count(count)]),
    ),
    issues: report.issues.slice(0, 50).map((issue) => ({
      kind: L.category(issue.kind),
      blocking: L.flag(issue.blocking),
      row: L.count(issue.row),
      field: L.text(issue.field),
      message: L.text(issue.message),
    })),
  };
}
