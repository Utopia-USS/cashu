/** Public plain preview DTO, never raw file bytes or a mutable native import plan. */
import { instrumentLabel } from "@cashu/domain/investments";
import {
  MAX_FILE_BYTES,
  planDuplicateCount,
  planNewCount,
} from "@cashu/domain/investments/importing";
import { z } from "zod";
import { gid } from "../../events/v1/primitives.js";
import type { UiAction } from "../../ui-actions.js";
import type { CommitResult } from "../commands/imports.js";
import type { ImportPreview } from "../queries/import-preview.js";

const count = z.number().int().nonnegative();
export const importCommitResultSchema = z.strictObject({
  batch: z.string(),
  inserted: count,
  duplicates: count,
  newInstruments: z.array(z.string()),
  positions: count,
  renames: count,
  statusChanges: count,
  corrections: count,
  archive: z.string(),
  instrumentMap: z.record(z.string(), z.string()),
  plannedBooked: z.array(z.string()),
});

export function importPreviewForUi(preview: ImportPreview) {
  const plan = preview.plan;
  return {
    fileName: preview.request.file.name,
    size: preview.request.file.content.length,
    sha256: preview.sha256,
    account: {
      gid: preview.account.gid,
      name: preview.account.name,
      currency: preview.account.currency,
    },
    importer: { id: preview.importerId, name: preview.importerName, detected: preview.detected },
    accountHint: preview.parse?.accountHint ?? null,
    canCommit: preview.canCommit,
    warnings: preview.warnings,
    errors: preview.errors,
    previousBatches: preview.previousBatches,
    counts:
      plan === null
        ? null
        : {
            rows: plan.rows.length,
            new: planNewCount(plan),
            duplicates: planDuplicateCount(plan),
            positions: plan.positions.length,
            newInstruments: plan.newInstruments.length,
            renames: plan.renames.length,
            statusChanges: plan.statusChanges.length,
          },
    rows:
      plan?.rows.map((row) => ({
        index: row.parsed.rowIndex,
        tradeDate: row.txn.tradeDate,
        type: row.txn.type,
        instrument:
          row.txn.instrumentId === null
            ? null
            : {
                id: row.txn.instrumentId,
                label: plan.instruments.get(row.txn.instrumentId)?.name ?? row.txn.instrumentId,
              },
        quantity: row.txn.quantity,
        price: row.txn.price,
        currency: row.txn.currency,
        cashAmount: row.txn.cashAmount,
        cashCurrency: row.txn.cashCurrency,
        duplicate: row.isDuplicate,
      })) ?? [],
    newInstruments:
      plan?.newInstruments.map((instrument) => ({
        id: instrument.id,
        label: instrumentLabel(instrument),
        currency: instrument.currency,
      })) ?? [],
    renames: plan?.renames.map((row) => row.rename) ?? [],
    statusChanges:
      plan?.statusChanges.map((row) => ({
        instrument: row.instrumentId,
        status: row.status,
        date: row.parsed.date,
      })) ?? [],
    reconciliation: preview.reconciliation,
  };
}
export type ImportPreviewDto = ReturnType<typeof importPreviewForUi>;
export const investmentPreviewInputSchema = z.strictObject({
  account: gid,
  selection: z.string().min(1).max(100).optional(),
  importer: z.enum(["auto", "cashu", "generic_csv"]).optional(),
  mappingYaml: z.string().max(MAX_FILE_BYTES).nullable().optional(),
});
export type InvestmentPreviewInput = z.input<typeof investmentPreviewInputSchema>;
export type InvestmentPreviewResult =
  | { readonly status: "previewed"; readonly stage: string; readonly preview: ImportPreviewDto }
  | { readonly status: "blocked"; readonly preview: ImportPreviewDto }
  | { readonly status: "cancelled" };
export type InvestmentCommitResult =
  | {
      readonly status: "committed";
      readonly result: CommitResult;
      readonly stagingCleanup: "retained";
      readonly publicationCleanupFailed: boolean;
    }
  | {
      readonly status: "refused";
      readonly reason: string;
      readonly preparation: "none" | "retained";
    }
  | { readonly status: "recovery_required"; readonly reason: string };
export const investmentImportPreview: UiAction<InvestmentPreviewInput, InvestmentPreviewResult> = {
  id: "investments.import.preview",
};
export const investmentImportCommit: UiAction<
  { readonly stage: string; readonly corrections?: readonly string[] },
  InvestmentCommitResult
> = { id: "investments.import.commit" };
