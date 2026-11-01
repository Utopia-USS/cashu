// The strategy state and inputs the producers compute in TS (formerly the strategy bridge) and the
// investments.strategy_loader output, over a synthetic dataset with invented strategy files.

import { afterEach, describe, expect, it } from "vitest";
import { withPythonDb } from "../../sources/index.ts";
import { INVESTMENTS, type SyntheticDataset, syntheticDataset } from "../../sources/testing.ts";
import { dumps } from "../output.ts";
import { strategyInputs } from "./strategy.ts";
import { produceStrategyLoader } from "./strategyLoader.ts";

let ds: SyntheticDataset;
afterEach(() => ds.dispose());

type Tree = Record<string, unknown>;

const STRATEGY = [
  "version: 1",
  "base_currency: PLN",
  "contributions: { monthly_amount: 1500, day_of_month: 5 }",
  "data: { max_price_age_days: 3 }",
  "buckets:",
  "  - { id: equity, match: { asset_class: etf } }",
  "  - { id: cash, match: { asset_class: cash } }",
  "allocation:",
  "  targets: { cash: 0.25, equity: 0.75 }",
  "rules:",
  "  - { id: drift, kind: allocation_drift }",
  "  - { id: idle, kind: custom, params: { when: 'cash_weight > 30%' } }",
  "benchmark: { id: world, proxy: TETF }",
  "",
].join("\r\n");

function run<T>(fn: (db: Parameters<Parameters<typeof withPythonDb>[1]>[0]) => T): T {
  return withPythonDb({ dataset: "demo", sourceDir: ds.dir, runRoot: ds.runRoot }, fn);
}

describe("strategy inputs from the TS loader", () => {
  it("reads the files (CRLF as LF), loads them and derives the pipeline inputs", () => {
    ds = syntheticDataset(INVESTMENTS);
    ds.writeFile("profiles/test-b/strategy.yaml", STRATEGY);
    ds.writeFile("profiles/test-b/strategy.md", "# Cel\n");
    const [p1, p2] = run((db) => {
      const inputs = strategyInputs(db);
      return [inputs.get(db.keys.key("profiles", 1)), inputs.get(db.keys.key("profiles", 2))];
    });
    expect(p1?.state).toBe("valid");
    expect(p1?.maxPriceAgeDays).toBe(3);
    expect(p1?.maxFxAgeDays).toBe(10);
    expect(p1?.benchmark).toEqual({ id: "world", proxy: "TETF" });
    expect(p1?.contributions?.monthlyAmount.toString()).toBe("1500");
    expect(p1?.contributions?.dayOfMonth).toBe(5);
    expect(p1?.strategy?.baseCurrency).toBe("PLN");
    expect(p1?.strategy?.allocation.buckets.map((b) => b.id)).toEqual(["equity", "cash"]);
    expect([...(p1?.strategy?.allocation.targets ?? [])]).toEqual([
      ["cash", 0.25],
      ["equity", 0.75],
    ]);
    // no strategy.yaml: valuation only, the default thresholds
    expect(p2).toEqual({
      state: "missing",
      benchmark: null,
      maxPriceAgeDays: 5,
      maxFxAgeDays: 10,
      contributions: null,
      strategy: null,
    });
  });

  it("a partial strategy (a broken rule) still feeds the pipeline; an invalid one does not", () => {
    ds = syntheticDataset(INVESTMENTS);
    ds.writeFile(
      "profiles/test-b/strategy.yaml",
      "version: 1\nbase_currency: PLN\nrules:\n  - { id: x, kind: nope }\n",
    );
    ds.writeFile("profiles/test-a/strategy.yaml", "version: 1\n");
    const [p1, p2] = run((db) => {
      const inputs = strategyInputs(db);
      return [inputs.get(db.keys.key("profiles", 1)), inputs.get(db.keys.key("profiles", 2))];
    });
    expect(p1?.state).toBe("partial");
    expect(p1?.strategy?.baseCurrency).toBe("PLN");
    expect(p2?.state).toBe("invalid");
    expect(p2?.strategy).toBeNull();
  });

  it("a file too large to read makes the strategy invalid with the read error", () => {
    ds = syntheticDataset(INVESTMENTS);
    ds.writeFile("profiles/test-b/strategy.yaml", `# ${"x".repeat(512_000 * 4)}\n`);
    const out = run((db) => JSON.parse(dumps(produceStrategyLoader(db))) as Tree);
    const p1 = Object.values(out).find((v) => (v as Tree).read_error !== null) as Tree;
    expect(p1.state).toBe("invalid");
    expect(p1.read_error).toBe("cannot read the strategy files: strategy.yaml is too large");
    expect(p1.result).toBeNull();
  });
});

describe("investments.strategy_loader", () => {
  it("writes state, digest, the stored version and the load result like canon.py", () => {
    ds = syntheticDataset(INVESTMENTS);
    ds.writeFile("profiles/test-b/strategy.yaml", STRATEGY);
    ds.exec(
      "INSERT INTO inv_strategy_versions (id, profile_id, version, sha256, yaml_text, state) VALUES (1, 1, 1, 'old', '', 'valid'), (2, 1, 2, 'older', '', 'valid')",
    );
    const out = run((db) => JSON.parse(dumps(produceStrategyLoader(db))) as Tree);
    const entries = Object.entries(out).filter(([k]) => k !== "templates");
    expect(entries).toHaveLength(2);
    const p1 = entries.map(([, v]) => v as Tree).find((v) => v.state === "valid") as Tree;
    expect(p1.version).toBe(2);
    expect(p1.changed).toBe(true);
    expect(p1.sha256).toMatch(/^[0-9a-f]{64}$/);
    const result = p1.result as Tree;
    const config = result.config as Tree;
    expect(config.base_currency).toBe("PLN");
    expect((config.contributions as Tree).monthly_amount).toBe("1500");
    const rules = config.rules as Tree[];
    expect(rules.map((r) => r.kind)).toEqual(["allocation_drift", "custom"]);
    const custom = (rules[1] as Tree).params as Tree;
    expect((custom.expression as Tree).source).toBe("cash_weight > 30%");
    expect(result.issues).toEqual([]);
    const templates = out.templates as Tree;
    expect(Object.keys(templates).sort()).toEqual(["blank", "passive_etf"]);
    expect((templates.passive_etf as Tree).issues).toEqual([]);
  });
});
