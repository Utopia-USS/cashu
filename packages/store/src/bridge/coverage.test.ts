// The completeness guard (S31a spec 4.4, lead decision: coverage guard (b)): `coverage.json` is the
// coverage table of the bridges in code, so a change to a bridge's columns or ops updates the file in
// the same commit, and Python's `tests/test_bridge_coverage.py` fails on a synced column or explicit op
// the file does not classify. Regenerate with `CASHU_UPDATE_COVERAGE=1 pnpm --filter @cashu/store exec
// vitest run src/bridge/coverage.test.ts` after a deliberate change (then `pnpm format` lays it out).
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { coverage } from "./coverage.js";

const FILE = new URL("./coverage.json", import.meta.url);
const text = () => `${JSON.stringify(coverage(), null, 2)}\n`;

describe("bridge coverage", () => {
  it("coverage.json is the coverage table of the bridges in code", () => {
    if (process.env.CASHU_UPDATE_COVERAGE === "1") writeFileSync(FILE, text());
    expect(JSON.parse(readFileSync(FILE, "utf8"))).toEqual(coverage());
  });

  it("classifies every column with at least one carrying event or a reason", () => {
    for (const [table, t] of Object.entries(coverage().tables)) {
      for (const [column, rule] of Object.entries(t.columns)) {
        const ok = typeof rule === "string" ? rule.startsWith("not shipped: ") : rule.length > 0;
        expect(ok, `${table}.${column}`).toBe(true);
      }
      expect(t.ops.length, table).toBeGreaterThan(0);
    }
  });
});
