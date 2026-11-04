import { budget, core } from "@cashu/domain";
import { reportOk, validateImportFile } from "@cashu/domain/investments/importing";
import { previewImport } from "@cashu/store/investments/queries";

const registry = core.builtinRegistry();
export type ValidatedConnectorDocument =
  | {
      readonly ok: true;
      readonly module: "budget";
      readonly statement: budget.ParsedStatement;
      readonly warnings: number;
    }
  | { readonly ok: true; readonly module: "investments"; readonly warnings: number }
  | { readonly ok: false; readonly code: "invalid_document" | "oversized_document" };

/** Exact connector bytes enter the same domain validators as ordinary local imports. */
export function validateConnectorDocument(
  module: "budget" | "investments",
  bytes: Uint8Array,
): ValidatedConnectorDocument {
  if (bytes.byteLength === 0 || bytes.byteLength > 64 * 1024 * 1024)
    return { ok: false, code: "oversized_document" };
  if (module === "budget") {
    const parsed = budget.parseBudgetDocument(bytes, "connector.json", {
      registry: registry.institutions,
      source: "connector",
    });
    if (!budget.canonicalOk(parsed) || !parsed.statement)
      return { ok: false, code: "invalid_document" };
    return {
      ok: true,
      module,
      statement: parsed.statement,
      warnings: parsed.issues.filter((issue) => !issue.blocking).length,
    };
  }
  const report = validateImportFile({ name: "connector.json", content: bytes });
  if (!reportOk(report)) return { ok: false, code: "invalid_document" };
  return { ok: true, module, warnings: report.warnings.length };
}

/** Read-only account/dedup/reconciliation preview. The caller stages and commits through S60/D7. */
export function previewConnectorInvestment(input: {
  readonly read: Parameters<typeof previewImport>[0];
  readonly bytes: Uint8Array;
  readonly account: string;
  readonly connectorId: string;
  readonly connectorName: string;
  readonly now: string;
}) {
  const validated = validateConnectorDocument("investments", input.bytes);
  if (!validated.ok) return { ok: false as const, reason: validated.code };
  const preview = previewImport(
    input.read,
    {
      file: { name: "connector.json", content: input.bytes },
      account: input.account,
      importer: `connector:${input.connectorId}`,
      connectorName: input.connectorName,
      boundAccount: true,
    },
    input.now,
  );
  if (!preview.ok) return { ok: false as const, reason: preview.reason };
  return { ok: true as const, preview: preview.preview, domainWarnings: validated.warnings };
}
