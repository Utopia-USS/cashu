// Port of tests/investments/strategy/test_generic_buckets.py (F7-GB GB1): every bucket id the shipped
// strategy templates use, active or in a commented example, is in GENERIC_BUCKET_IDS; the match is
// exact and case-sensitive.

import { describe, expect, it } from "vitest";
import { GENERIC_BUCKET_IDS, isGenericBucket } from "../domain/buckets.js";
import {
  loadStrategy,
  STRATEGY_TEMPLATE_NAMES,
  type StrategyTemplate,
  strategyTemplate,
} from "./index.js";
import { splitLines } from "./testing/load.js";

function template(name: string): StrategyTemplate {
  const found = strategyTemplate(name);
  expect(found, name).not.toBeNull();
  if (found === null) throw new Error(`no template ${name}`);
  return found;
}

/** `_uncommented`: lines with a column-0 `#` and one space removed. */
function uncommented(text: string): string[] {
  return splitLines(text).map((line) => line.replace(/^# ?/, ""));
}

/** `_example_bucket_ids`: `- id:` entries of every `buckets:` block (commented or not). */
function exampleBucketIds(text: string): Set<string> {
  const ids = new Set<string>();
  let inside = false;
  for (const line of uncommented(text)) {
    if (/^buckets:\s*$/.test(line)) {
      inside = true;
      continue;
    }
    if (inside && line && !/^\s/.test(line)) inside = false;
    const m = inside ? /^\s*-\s*id:\s*([A-Za-z0-9_]+)/.exec(line) : null;
    if (m?.[1] !== undefined) ids.add(m[1]);
  }
  return ids;
}

/** `_example_target_ids`: keys of every inline `targets: { id: weight, ... }` mapping. */
function exampleTargetIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const block of text.matchAll(/targets:\s*\{([^}]*)\}/g)) {
    for (const key of (block[1] ?? "").matchAll(/([A-Za-z0-9_]+)\s*:/g)) {
      if (key[1] !== undefined) ids.add(key[1]);
    }
  }
  return ids;
}

describe("test_generic_buckets", () => {
  it.each(STRATEGY_TEMPLATE_NAMES)("test_every_template_bucket_id_is_generic[%s]", (name) => {
    const t = template(name);
    const config = loadStrategy(t.yaml, t.markdown).config;
    expect(config).not.toBeNull();
    if (config === null) return;
    const loaded = new Set([
      ...config.allocation.buckets.map((b) => b.id),
      ...config.allocation.targets.keys(),
    ]);
    const all = new Set([...loaded, ...exampleBucketIds(t.yaml), ...exampleTargetIds(t.yaml)]);
    expect(all.size, "the template names no bucket at all").toBeGreaterThan(0);
    expect([...all].filter((id) => !GENERIC_BUCKET_IDS.has(id))).toEqual([]);
  });

  it("test_the_template_scan_finds_the_known_ids", () => {
    expect(exampleBucketIds(template("passive_etf").yaml)).toEqual(
      new Set(["global_equity", "bond_etfs", "treasury_bonds", "cash"]),
    );
    const blank = template("blank").yaml;
    expect(exampleBucketIds(blank)).toEqual(exampleTargetIds(blank));
    expect(exampleTargetIds(blank)).toEqual(new Set(["stocks", "bonds", "cash"]));
  });

  it("test_plain_asset_class_ids_are_generic_and_the_match_is_exact", () => {
    for (const bucketId of [
      "stocks",
      "equity",
      "equities",
      "bonds",
      "fixed_income",
      "cash",
      "crypto",
      "real_estate",
      "reits",
      "commodities",
      "gold",
    ]) {
      expect(isGenericBucket(bucketId), bucketId).toBe(true);
    }
    for (const bucketId of [
      "core",
      "active",
      "satellite",
      "Cash",
      "STOCKS",
      " cash",
      "",
      null,
      1,
    ]) {
      expect(isGenericBucket(bucketId), String(bucketId)).toBe(false);
    }
  });
});
