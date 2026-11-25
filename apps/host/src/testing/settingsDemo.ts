/** Electron102 proposals exist only in the generated, isolated native Store. */
import { strategyDigest } from "@cashu/domain/investments/strategy";
import { runCommand } from "@cashu/store";
import { createProposal } from "@cashu/store/core";
import type { OpenVault } from "../stores.js";

export async function seedSettingsDemo(
  vault: OpenVault,
  files: { readonly yaml: string | null; readonly md: string | null },
): Promise<void> {
  if (process.env.CASHU_E2E_SETTINGS !== "1" || process.env.CASHU_TESTING !== "1")
    throw new Error("synthetic_settings_required");
  const proposals = [
    {
      kind: "strategy" as const,
      summary: "Synthetic Settings102 strategy",
      summaryParams: { rules: 2, buckets: 1, inactive_rules: 0 },
      reason: "Synthetic strategy review reason",
      payload: {
        yaml: `${files.yaml ?? ""}\n# synthetic Settings102 proposal\n`,
        md: files.md,
        base_sha256: strategyDigest(files.yaml ?? "", files.md),
      },
    },
    {
      kind: "custom_rule" as const,
      summary: "Synthetic Settings102 rule",
      summaryParams: { rule_kind: "price_change", episodes: 1 },
      reason: "Synthetic rule review reason",
      payload: {
        rule: { id: "settings102", kind: "price_change", params: { threshold_pct: 5 } },
        rule_yaml: "- id: settings102",
        backtest: {
          from: "2026-01-01",
          to: "2026-01-31",
          evaluated: 9,
          points_fired: 2,
          episodes: 1,
        },
      },
    },
    {
      kind: "import" as const,
      summary: "Synthetic Settings102 investment import",
      summaryParams: {
        account: "Synthetic brokerage",
        importer: "synthetic",
        new: 2,
        duplicates: 1,
      },
      reason: "Synthetic investment import review reason",
      payload: {
        file_name: "synthetic-investment.csv",
        account_label: "Synthetic brokerage",
        preview: { new: 2, duplicates: 1, reconciliation_mismatches: 0 },
        converter_unsupported: true,
      },
    },
    {
      kind: "budget_import" as const,
      summary: "Synthetic Settings102 budget import",
      summaryParams: { account: "Synthetic checking", connector: "Synthetic connector", new: 3 },
      reason: "Synthetic statement import review reason",
      payload: {
        file_name: "synthetic-statement.csv",
        account_label: "Synthetic checking",
        connector_name: "Synthetic connector",
        source: "connector",
        preview: { new: 3, duplicates: 1, warnings: 1 },
      },
    },
  ];
  for (const proposal of proposals) {
    const result = await vault.queue.run(() =>
      runCommand(
        vault.store,
        vault.writer,
        createProposal,
        { ...proposal, source: "synthetic" },
        vault.env,
      ),
    );
    if (!result.ok) throw new Error(`synthetic_settings_${result.reason}`);
  }
}
