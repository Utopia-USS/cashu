// The small checks of the Python-generated vector files (packages/mcp/test/privacy_vectors.py). The
// differential sweeps over the same files run in the exhaustive tier
// (privacy.vectors.exhaustive.test.ts); the shared adversarial vectors stay fast in
// sharedVectors.test.ts.

import * as macro from "@cashu/domain/investments/macro";
import { describe, expect, it } from "vitest";
import {
  enabledIn,
  inputSchema,
  listedModule,
  type PropertySchema,
  toolSpec,
} from "../registry.js";
import { isMoneyKey } from "./redactor.js";
import { loadVectors } from "./testing/vectors.js";

interface SpecJson {
  name: string;
  module: string;
  properties: [string, PropertySchema][];
  required: string[];
  refused: Record<string, string>;
  refused_values: Record<string, Record<string, string>>;
  nullable: string[];
  also: string[];
  input_schema: unknown;
  enabled: Record<string, boolean>;
  listed: Record<string, string>;
}

describe("market text", () => {
  const file = loadVectors<{ vocabulary: string[]; summary_max: number }>("market");
  it("the summary vocabulary and maximum are the domain macro module's", () => {
    expect([...macro.vocabulary()].sort()).toEqual([...file.vocabulary].sort());
    expect(macro.SUMMARY_MAX).toBe(file.summary_max);
  });
});

describe("registry: input schema, module gating", () => {
  const file = loadVectors<{ specs: SpecJson[] }>("registry");
  it("lists the same schemas and modules", () => {
    for (const s of file.specs) {
      const spec = toolSpec<never>({
        name: s.name,
        module: s.module,
        description: "",
        handler: () => ({}),
        properties: Object.fromEntries(s.properties),
        required: s.required,
        refused: s.refused,
        refusedValues: s.refused_values,
        nullable: s.nullable,
        also: s.also,
      });
      expect(inputSchema(spec)).toEqual(s.input_schema);
      for (const mod of Object.keys(s.enabled)) {
        expect(enabledIn(spec, new Set([mod]))).toBe(s.enabled[mod]);
        expect(listedModule(spec, new Set([mod]))).toBe(s.listed[mod]);
      }
    }
  });
});

describe("S37fix money keys", () => {
  const file = loadVectors<{ money_keys: Record<string, boolean> }>("adversarial");
  it("classifies money keys like Python", () => {
    for (const [key, money] of Object.entries(file.money_keys)) {
      expect(isMoneyKey(key), key).toBe(money);
    }
  });
});
