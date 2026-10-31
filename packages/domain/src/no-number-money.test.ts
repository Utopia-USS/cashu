/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Guard: money is never a JS number in @cashu/domain (port contract, scope S05). Every source file
 * under src/ (tests and test helpers excluded) is scanned for
 * - a money-named binding typed with `number` (`amount: number`, `price?: number | null`, ...),
 * - JS float parsing / formatting, whose rounding differs from Python (`parseFloat`, `toFixed`,
 *   `toPrecision`): use `Decimal.parse`, `Decimal.format` / `formatFloat` instead.
 * A line may opt out with a `// float-ok: <reason>` comment where Python itself uses a float.
 */
const SRC = fileURLToPath(new URL(".", import.meta.url));
const MONEY_NAMES =
  "amount|price|balance|total|cost|gross|cash|fee|tax|quantity|qty|money|payment|principal|interest|valuation|networth|netWorth|income|expense|spend|budget|cushion|rate";
const MONEY_AS_NUMBER = new RegExp(
  `\\b(?:\\w*(?:${MONEY_NAMES})\\w*)\\??\\s*:\\s*[^,)=;{]*\\bnumber\\b`,
  "i",
);
const FLOAT_TOOLS = /\bparseFloat\s*\(|\.toFixed\s*\(|\.toPrecision\s*\(/;

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "testing") out.push(...sources(path));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      out.push(path);
    }
  }
  return out;
}

export function moneyNumberViolations(files: readonly string[]): string[] {
  const hits: string[] = [];
  for (const file of files) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (line.includes("float-ok:")) return;
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "");
        if (MONEY_AS_NUMBER.test(code) || FLOAT_TOOLS.test(code)) {
          hits.push(`${relative(SRC, file)}:${i + 1}: ${line.trim()}`);
        }
      });
  }
  return hits;
}

describe("no JS number for money in @cashu/domain", () => {
  it("scans every source file", () => {
    const files = sources(SRC);
    expect(files.length).toBeGreaterThan(0);
    expect(moneyNumberViolations(files)).toEqual([]);
  });

  it("catches the patterns it is meant to catch", () => {
    const samples = [
      "const amount: number = 0;",
      "  unitPrice?: number | null;",
      "function f(totalCost: number) {}",
      "const x = parseFloat(text);",
      "return value.toFixed(2);",
    ];
    for (const sample of samples) {
      expect(MONEY_AS_NUMBER.test(sample) || FLOAT_TOOLS.test(sample), sample).toBe(true);
    }
    expect(MONEY_AS_NUMBER.test("const amount: Decimal = ZERO;")).toBe(false);
    expect(MONEY_AS_NUMBER.test("function weekday(date: IsoDate): number {")).toBe(false);
  });
});
