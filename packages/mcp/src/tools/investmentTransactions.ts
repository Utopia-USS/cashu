/** `validate_transactions`: rows typed in from chat checked like an import file, value-free. */
import * as importing from "@cashu/domain/investments/importing";
import * as L from "../privacy/labels.js";
import type { ToolArgs, ToolContext } from "../registry.js";
import type { NativeToolStore } from "../runtime/types.js";
import { account, answerPreview, labelled, preview } from "./investmentImportProposal.js";
import { byKind } from "./investmentsImport.js";
import { canonicalRows, rowsDocument, rowsSource } from "./investmentTransactionRows.js";

export function validateInvestmentTransactions(
  ctx: ToolContext<NativeToolStore>,
  args: ToolArgs,
): L.LabelledTree {
  const rows = canonicalRows(args.rows);
  const given = typeof args.account === "string" && args.account.trim() !== "";
  const selected = given ? account(ctx, args) : null;
  const file = rowsDocument(rows, rowsSource(args, selected?.bank ?? null));
  const report = importing.validateImport({ name: file.name, content: file.bytes });
  const out: Record<string, L.LabelledTree> = {
    ok: L.flag(importing.reportOk(report)),
    rows: L.count(rows.length),
    transactions: L.count(importing.reportTxnCount(report)),
    errors: L.count(report.errors.length),
    warnings: L.count(report.warnings.length),
    errors_by_kind: byKind(report.errors),
    warnings_by_kind: byKind(report.warnings),
  };
  if (selected === null) return out;
  out.account = L.account(selected.label);
  out.preview = labelled(
    answerPreview(
      preview(ctx, {
        account: selected.gid,
        file: { name: file.name, content: file.bytes },
        importer: "cashu",
      }),
    ),
  );
  return out;
}
