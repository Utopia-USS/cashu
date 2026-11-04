/** Ordinary import proposal creation. Checked blob publication precedes this synchronous command. */
import { sha256Hex } from "@cashu/domain";
import {
  planDuplicateCount,
  planNewCount,
  reportMismatches,
} from "@cashu/domain/investments/importing";
import { z } from "zod";
import { type CommandResult, defineCommand, ok, refuse } from "../../command.js";
import { createProposal } from "../../core/proposal-commands.js";
import { archiveExtension } from "../commands/imports.js";
import {
  type ImportPreview,
  type ImportRequest,
  previewImport,
} from "../queries/import-preview.js";
import type { BlobRef } from "./imports.js";

export function ownInvestmentImportRequest(input: ImportRequest): ImportRequest {
  return Object.freeze({
    ...input,
    file: Object.freeze({ name: input.file.name, content: Uint8Array.from(input.file.content) }),
  });
}
export function investmentImportSummary(preview: ImportPreview) {
  const p = preview.plan;
  return {
    importer: preview.importerId,
    can_commit: preview.canCommit,
    rows: p?.rows.length ?? 0,
    new: p ? planNewCount(p) : 0,
    duplicates: p ? planDuplicateCount(p) : 0,
    positions: p?.positions.length ?? 0,
    renames: p?.renames.length ?? 0,
    status_changes: p?.statusChanges.length ?? 0,
    new_instruments: p?.newInstruments.length ?? 0,
    reconciliation_mismatches: preview.reconciliation
      ? reportMismatches(preview.reconciliation).length
      : 0,
    warnings: preview.warnings.length,
    errors: preview.errors.length,
  };
}
export type ImportProposalCreation =
  | { readonly stored: false; readonly preview: ImportProposalPreview }
  | {
      readonly stored: true;
      readonly proposalGid: string;
      readonly preview: ImportProposalPreview;
    };
/** The durable command result carries only the fields used by the MCP answer. */
export interface ImportProposalPreview {
  readonly summary: ReturnType<typeof investmentImportSummary>;
  readonly warnings: ImportPreview["warnings"];
  readonly errors: ImportPreview["errors"];
}
const answerPreview = (preview: ImportPreview): ImportProposalPreview => ({
  summary: investmentImportSummary(preview),
  warnings: preview.warnings,
  errors: preview.errors,
});
/** Construct only inside final reentry; no command/read/clock is retained over publication. */
export function createInvestmentImportProposal(
  authority: { readonly vault: string; isCurrent(): boolean },
  input: ImportRequest,
  published: BlobRef,
  accountLabel: string,
) {
  const request = ownInvestmentImportRequest(input);
  const blob = Object.freeze({ sha256: published.sha256, ext: published.ext });
  return defineCommand({
    id: "investments.mcp.createImportProposal",
    input: z.object({ reason: z.string().nullable().default(null) }),
    run(ctx, args): CommandResult<ImportProposalCreation> {
      if (ctx.vault !== authority.vault || !authority.isCurrent())
        return refuse("publication_unavailable");
      if (
        request.importer?.startsWith("connector:") ||
        request.connectorName ||
        request.boundAccount
      )
        return refuse("connector_binding_unsupported");
      if (
        blob.sha256 !== sha256Hex(request.file.content) ||
        blob.ext !== archiveExtension(request.file.name)
      )
        return refuse("staged_changed");
      const checked = previewImport(ctx.read, request, ctx.now());
      if (!checked.ok) return refuse(checked.reason);
      const preview = checked.preview,
        summary = investmentImportSummary(preview);
      if (!preview.canCommit)
        return ok({ stored: false as const, preview: answerPreview(preview) });
      const out = createProposal.run(
        ctx,
        createProposal.input.parse({
          kind: "import",
          source: "mcp",
          reason: args.reason,
          summary: `Import into ${accountLabel} (${summary.importer ?? request.importer ?? "auto"}): ${summary.new} new rows`,
          payload: {
            account: request.account,
            account_label: accountLabel,
            blob,
            file_name: request.file.name,
            file_sha256: blob.sha256,
            importer: request.importer ?? "auto",
            mapping_yaml: request.mappingYaml ?? null,
            preview: summary,
          },
        }),
      );
      if (!out.ok) return out;
      return ok({
        stored: true as const,
        proposalGid: out.value.proposalGid,
        preview: answerPreview(preview),
      });
    },
  });
}
