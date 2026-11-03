import { strategyDigest } from "@cashu/domain/investments/strategy";
import type { ProposalDetail } from "@cashu/store/core/desktop-proposals";
import { expect, it } from "vitest";
import { projectProposalDetail } from "./proposalDetail.js";

const row = (kind: ProposalDetail["kind"], payload: Record<string, unknown>): ProposalDetail => ({
  gid: "019a48cf-0285-8a09-bf65-a2741b2c9a72",
  kind,
  status: "pending",
  summary: "Synthetic",
  reason: "Synthetic reason",
  source: "synthetic",
  createdAt: "2026-11-03T08:00:00Z",
  reviewedAt: null,
  payload,
  result: {},
  nextStrategyVersion: kind === "strategy" || kind === "custom_rule" ? 2 : null,
});
const image = {
  vault: "5f0c3a9e81d24b7690ae13c7d2f4b856",
  generation: "test",
  revision: "r1",
  files: { yaml: "rules: []\n", md: "old\n", readError: null },
};

it("projects current strategy and rule diffs, stale base, stored backtest and import metadata", () => {
  const strategy = projectProposalDetail(
    row("strategy", {
      yaml: "rules: []\nbase_currency: PLN\n",
      md: "new\n",
      base_sha256: strategyDigest(image.files.yaml, image.files.md),
    }),
    image,
  );
  expect(strategy.display).toMatchObject({ diffAvailability: "ready", baseChanged: false });
  expect(strategy.display?.yamlDiff).toContain("+base_currency: PLN");
  expect(strategy.display?.mdDiff).toContain("+new");
  expect(
    projectProposalDetail(
      row("strategy", {
        yaml: "rules: []\n",
        base_sha256: "stale",
      }),
      image,
    ).display,
  ).toMatchObject({ baseChanged: true, mdDiff: null });
  expect(
    projectProposalDetail(row("strategy", { yaml: "rules: []\n", md: "" }), image).display?.mdDiff,
  ).toContain("-old");
  expect(
    projectProposalDetail(
      row("custom_rule", {
        rule: { id: "new", kind: "price_change", params: { threshold_pct: 5 } },
        rule_yaml: "- id: new",
        backtest: { evaluated: 9, points_fired: 2 },
      }),
      image,
    ).display,
  ).toMatchObject({ diffAvailability: "ready", backtest: { evaluated: 9, points_fired: 2 } });
  expect(projectProposalDetail(row("strategy", { yaml: "new" }), null).display).toMatchObject({
    diffAvailability: "unavailable",
    yamlDiff: null,
  });
  expect(
    projectProposalDetail(row("strategy", { yaml: "new\n" }), {
      ...image,
      files: { ...image.files, yaml: "old\n".repeat(20_001) },
    }).display,
  ).toMatchObject({ diffAvailability: "unavailable", detailError: "diff_too_large" });
  expect(
    projectProposalDetail(
      row("import", {
        account: "synthetic-account",
        file_name: "synthetic.csv",
        preview: { new: 2, duplicates: 1, reconciliation_mismatches: 0 },
        converter: { name: "synthetic legacy converter" },
      }),
      null,
    ).display,
  ).toMatchObject({
    account: "synthetic-account",
    fileName: "synthetic.csv",
    converterUnsupported: true,
  });
  expect(
    projectProposalDetail(
      row("budget_import", {
        account_label: "Synthetic budget",
        connector_name: "Synthetic connector",
        since: "2026-10-01",
        source: "connector",
        preview: { new: 3, warnings: 1 },
      }),
      null,
    ).display,
  ).toMatchObject({ fromConnector: true, preview: { new: 3, warnings: 1 } });
  expect(
    projectProposalDetail(row("strategy", { yaml: "private" }), image, true).display,
  ).toMatchObject({ diffAvailability: "unavailable", yamlDiff: null });
});
