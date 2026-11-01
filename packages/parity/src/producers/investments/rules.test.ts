import { afterEach, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { INVESTMENTS, type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { produceRules } from "./rules.ts";
import { strategyInputs } from "./strategy.ts";

let dataset: SyntheticDataset | undefined;
afterEach(() => dataset?.dispose());

it("evaluates native strategy rules and changes outcomes when their threshold changes", () => {
  const ds = syntheticDataset(INVESTMENTS);
  dataset = ds;
  const strategy = (threshold: number) =>
    [
      "version: 1",
      "base_currency: PLN",
      "contributions: { monthly_amount: 1500, day_of_month: 5 }",
      "rules:",
      `  - { id: monthly, kind: custom, params: { when: 'monthly_contribution > ${threshold}' } }`,
      "",
    ].join("\n");
  const run = () =>
    withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      const result = JSON.parse(dumps(produceRules(db, strategyInputs(db))));
      return result[db.keys.key("profiles", 1)];
    });
  ds.writeFile("profiles/test-b/strategy.md", "# Synthetic plan\n");
  ds.writeFile("profiles/test-b/strategy.yaml", strategy(100));
  const fired = run();
  expect(fired.strategy_state).toBe("valid");
  expect(fired.rules).toEqual([{ id: "monthly", kind: "custom" }]);
  expect(fired.outcomes).toHaveLength(1);
  expect(fired.outcomes[0].type).toBe("Fired");
  expect(fired.outcomes[0].outcome.candidate.payload.values.monthly_contribution).toBe("1500");
  ds.writeFile("profiles/test-b/strategy.yaml", strategy(2000));
  expect(run().outcomes[0].type).toBe("NotFired");
  ds.writeFile("profiles/test-b/strategy.yaml", strategy(100).replace("id: monthly", "id: '123'"));
  expect(run).toThrow("unmapped numeric rule payload identifier");
});

it("keeps missing and invalid profiles separate and evaluates usable partial strategies", () => {
  const ds = syntheticDataset(INVESTMENTS);
  dataset = ds;
  const run = () =>
    withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, (db) => {
      const result = JSON.parse(dumps(produceRules(db, strategyInputs(db))));
      return [result[db.keys.key("profiles", 1)], result[db.keys.key("profiles", 2)]];
    });
  expect(run()).toEqual([
    { strategy_state: "missing", outcomes: null },
    { strategy_state: "missing", outcomes: null },
  ]);
  ds.writeFile("profiles/test-a/strategy.yaml", "version: 1\n");
  ds.writeFile(
    "profiles/test-b/strategy.yaml",
    [
      "version: 1",
      "base_currency: PLN",
      "rules:",
      "  - { id: incomplete, kind: custom, params: { when: 'monthly_contribution > 100' } }",
      "  - { id: unsupported, kind: nope }",
      "",
    ].join("\n"),
  );
  const [partial, invalid] = run();
  expect(invalid).toEqual({ strategy_state: "invalid", outcomes: null });
  expect(partial.strategy_state).toBe("partial");
  expect(partial.rules).toEqual([{ id: "incomplete", kind: "custom" }]);
  expect(partial.outcomes).toHaveLength(1);
  expect(partial.outcomes[0].type).toBe("Skipped");
  expect(partial.outcomes[0].outcome.rule_id).toBe("incomplete");
});
