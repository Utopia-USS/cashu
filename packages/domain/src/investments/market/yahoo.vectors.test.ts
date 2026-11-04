// Yahoo price parsing (float32 noise removal, Python `f"{v:.{p}g}"` half-even digits) and exchange dates
// against Python-generated vectors: parity/python/generators/domain/market_vectors.py -> test/vectors/market-yahoo-price.jsonl.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exchangeDate, yahooPrice } from "./yahoo.js";

type Vector =
  | { kind: "price"; in: string; out?: string | null; error?: string }
  | { kind: "date"; epoch: number; offset: number; out: string };

const vectors: Vector[] = readFileSync(
  new URL("../../../test/vectors/market-yahoo-price.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Vector);

describe("yahoo vectors", () => {
  it("prices equal Python's _price (str), errors where Python raises", () => {
    const prices = vectors.filter((v) => v.kind === "price");
    expect(prices.length).toBeGreaterThan(16000);
    const mismatches: string[] = [];
    for (const v of prices) {
      const input = v.in === "-0.0" ? -0 : Number(v.in);
      let got: string;
      try {
        got = yahooPrice(input)?.toString() ?? "None";
      } catch {
        got = "error";
      }
      const want = v.error !== undefined ? "error" : (v.out ?? "None");
      if (got !== want) mismatches.push(`${v.in}: ${got} != ${want}`);
    }
    expect(mismatches.slice(0, 10)).toEqual([]);
  });

  it("exchange dates equal Python's exchange_date", () => {
    const dates = vectors.filter((v) => v.kind === "date");
    expect(dates.length).toBe(500);
    for (const v of dates) expect(exchangeDate(v.epoch, v.offset)).toBe(v.out);
  });
});
