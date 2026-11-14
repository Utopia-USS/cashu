import { strategyTemplate } from "@cashu/domain/investments/strategy";
import { expect, it } from "vitest";
import { createProfile, setModules } from "../../core/commands.js";
import { runQuery } from "../../query.js";
import { saveStrategyVersion } from "../commands/strategy.js";
import { vault } from "../commands/testing/fixtures.js";
import { latestStrategyVersion } from "../queries/strategy.js";
import { strategySnapshot } from "./sources.js";
import { strategyReaderQuery } from "./strategyReader.js";

it("reads the synced strategy text and the rules the parsed strategy runs", () => {
  const v = vault();
  try {
    const template = strategyTemplate("passive_etf");
    if (template === null) throw new Error("missing real template");
    const query = strategyReaderQuery({
      strategy: {
        changes: { subscribe: () => () => {} },
        current(read) {
          const latest = latestStrategyVersion(read);
          return strategySnapshot(read, {
            vault: v.store.vault,
            generation: "synced",
            revision: latest?.gid ?? "none",
            files: { yaml: latest?.yamlText ?? null, md: latest?.mdText ?? null, readError: null },
          });
        },
      },
    });
    v.value(createProfile, { slug: "synthetic", name: "Synthetic", modules: ["budget"] });
    expect(runQuery(v.store, query, undefined).value).toEqual({
      status: "unavailable",
      reason: "module_disabled",
    });
    v.value(setModules, { moduleIds: ["investments"] });
    expect(runQuery(v.store, query, undefined).value).toEqual({ status: "none" });
    v.value(saveStrategyVersion, { yamlText: template.yaml, mdText: template.markdown });
    const read = runQuery(v.store, query, undefined);
    expect(read.tables.has("inv_strategy_versions")).toBe(true);
    const value = read.value;
    if (value.status !== "current") throw new Error(value.status);
    expect(value.version).toMatchObject({ version: 1, mdText: template.markdown });
    expect(value.rules.map((rule) => rule.kind)).toEqual([
      "allocation_drift",
      "position_concentration",
      "cash_level",
      "drawdown_from_high",
      "contribution_gap",
      "custom",
    ]);
    expect(value.rules[1]).toMatchObject({
      id: "single_stock_limit",
      params: { maxWeight: 0.05 },
    });
  } finally {
    v.store.close();
  }
});
