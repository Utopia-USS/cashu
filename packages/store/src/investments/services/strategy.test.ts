// Strategy files of a profile: states, versions, the loader's partial config, path-safe profile dirs,
// the benchmark proxy registered on record. The files port is an in-memory fake. Synthetic data only.
import { loadStrategy as loadStrategyText } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { storeWriter } from "../../command.js";
import { otherVault, type Vault, vault } from "../commands/testing/fixtures.js";
import { findProxy } from "../performance/inputs.js";
import { latestStrategyVersion, strategyVersions } from "../queries/strategy.js";
import { MemoryStrategyDir } from "../testing/strategyFiles.js";
import { checkedProfileSlug, loadStrategy, STRATEGY_MD, STRATEGY_YAML } from "./strategy.js";

const STRATEGY = `version: 1
base_currency: PLN
data:
  max_price_age_days: 5
  max_stale_weight: 1.0
  max_unclassified_weight: 1.0
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
  - id: cash
    match: { asset_class: cash }
allocation:
  targets: { stocks: 0.9, cash: 0.1 }
rules:
  - id: concentration
    kind: position_concentration
    severity: action
    params: { max_weight: 0.30 }
  - id: idle_cash
    kind: cash_level
    params: { max_weight: 0.15 }
`;

const recording = (v: Vault, files: MemoryStrategyDir) =>
  ({ record: true, writer: storeWriter(v.store), env: v.env, sync: files.sync }) as const;
const read = (v: Vault) => v.store.read.bind(v.store);

describe("strategy files", () => {
  it("partial config when only rules have errors", () => {
    const broken = STRATEGY.replace("max_weight: 0.30", "max_weight: 2").replace(
      "kind: cash_level",
      "kind: cash_levle",
    );
    const result = loadStrategyText(broken);
    expect(result.config).toBeNull();
    expect(result.partial?.rules).toEqual([]);
    expect(result.inactiveRules.map((r) => [r.index, r.ruleId, r.kind])).toEqual([
      [0, "concentration", "position_concentration"],
      [1, "idle_cash", "cash_levle"],
    ]);
    for (const r of result.inactiveRules) {
      expect(r.line).toBeTruthy();
      expect(r.issues[0]?.severity).toBe("error");
    }
    const oneBroken = loadStrategyText(STRATEGY.replace("kind: cash_level", "kind: nope"));
    expect(oneBroken.partial?.rules.map((r) => r.id)).toEqual(["concentration"]);
    expect(Object.fromEntries(oneBroken.partial?.allocation.targets ?? [])).toEqual({
      stocks: 0.9,
      cash: 0.1,
    });
  });

  it("no partial config for errors outside rules", () => {
    const result = loadStrategyText(STRATEGY.replace("stocks: 0.9", "stocks: 0.5")); // targets sum
    expect([result.config, result.partial, result.inactiveRules]).toEqual([null, null, []]);
    const valid = loadStrategyText(STRATEGY);
    expect(valid.config).not.toBeNull();
    expect([valid.partial, valid.inactiveRules]).toEqual([null, []]);
  });

  it("states and versions", async () => {
    const v = vault();
    const files = new MemoryStrategyDir(v.store.vault);
    expect((await loadStrategy(v.store, files, recording(v, files))).state).toBe("missing");
    files.texts.set(STRATEGY_YAML, STRATEGY);
    let st = await loadStrategy(v.store, files);
    expect([st.state, st.version, st.changed]).toEqual(["valid", null, true]); // not recorded on read
    st = await loadStrategy(v.store, files, recording(v, files));
    expect(st.version?.version).toBe(1);
    expect(st.changed).toBe(false);
    st = await loadStrategy(v.store, files, recording(v, files));
    expect(st.version?.version).toBe(1); // unchanged
    files.texts.set(STRATEGY_MD, "Cel: emerytura.");
    expect((await loadStrategy(v.store, files, recording(v, files))).version?.version).toBe(2); // md counts
    files.texts.set(STRATEGY_YAML, "version: [");
    st = await loadStrategy(v.store, files, recording(v, files));
    expect([st.state, st.version?.version, st.config]).toEqual(["invalid", 3, null]);
    expect(st.issues[0]?.line).toBe(1);
    const rows = strategyVersions(read(v)).reverse();
    expect(rows.map((r) => [r.version, r.state])).toEqual([
      [1, "valid"],
      [2, "valid"],
      [3, "invalid"],
    ]);
    expect(rows[2]?.issues[0]?.severity).toBe("error");
    expect(rows[1]?.mdText).toBe("Cel: emerytura.");
  });

  it("profile dirs reject path tricks", () => {
    for (const bad of ["../x", "a/b", "", ".hidden", "ok\n"]) {
      expect(checkedProfileSlug(bad), JSON.stringify(bad)).toBeNull();
    }
    expect(checkedProfileSlug("jan-strateg_2")).toBe("jan-strateg_2");
  });
});

describe("strategy files: recording", () => {
  it("a read error is invalid and records nothing", async () => {
    const v = vault();
    const files = new MemoryStrategyDir(v.store.vault);
    files.texts.set(STRATEGY_YAML, STRATEGY);
    files.errors.set(STRATEGY_MD, "strategy.md is too large");
    const st = await loadStrategy(v.store, files, recording(v, files));
    expect([st.state, st.readError, st.version, st.changed]).toEqual([
      "invalid",
      "cannot read the strategy files: strategy.md is too large",
      null,
      false,
    ]);
    expect(strategyVersions(read(v))).toEqual([]);
  });

  it("a partial strategy is recorded with its usable config", async () => {
    const v = vault();
    const files = new MemoryStrategyDir(v.store.vault);
    files.texts.set(STRATEGY_YAML, STRATEGY.replace("kind: cash_level", "kind: nope"));
    const st = await loadStrategy(v.store, files, recording(v, files));
    expect(st.state).toBe("partial");
    expect(st.config?.rules.map((r) => r.id)).toEqual(["concentration"]);
    expect(st.inactiveRules.map((r) => r.ruleId)).toEqual(["idle_cash"]);
    expect(latestStrategyVersion(read(v))?.state).toBe("partial");
  });

  it("recording a strategy with a benchmark registers its proxy", async () => {
    const v = vault();
    const files = new MemoryStrategyDir(v.store.vault);
    files.texts.set(STRATEGY_YAML, `${STRATEGY}benchmark: { id: msci_acwi, proxy: REFX.DE }\n`);
    expect(findProxy(read(v), "REFX.DE")).toBeUndefined();
    await loadStrategy(v.store, files); // a read never writes
    expect(findProxy(read(v), "REFX.DE")).toBeUndefined();
    const st = await loadStrategy(v.store, files, recording(v, files));
    expect(st.state).toBe("valid");
    expect(findProxy(read(v), "REFX.DE")?.currency).toBe("EUR");
  });

  it("an unresolvable benchmark proxy never fails the load", async () => {
    const v = vault();
    const files = new MemoryStrategyDir(v.store.vault);
    files.texts.set(STRATEGY_YAML, `${STRATEGY}benchmark: { id: x, proxy: "???" }\n`);
    const st = await loadStrategy(v.store, files, recording(v, files));
    expect([st.state, st.version?.version]).toEqual(["valid", 1]);
  });

  it("another vault never sees the strategy versions", async () => {
    const v = vault();
    const other = otherVault();
    const files = new MemoryStrategyDir(v.store.vault);
    files.texts.set(STRATEGY_YAML, STRATEGY);
    await loadStrategy(v.store, files, recording(v, files));
    expect(strategyVersions(read(v))).toHaveLength(1);
    expect(strategyVersions(read(other))).toEqual([]);
    const st = await loadStrategy(other.store, files);
    expect([st.version, st.changed]).toEqual([null, true]);
  });
});
