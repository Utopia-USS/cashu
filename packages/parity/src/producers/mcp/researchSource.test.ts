import { USDPLN } from "@cashu/domain/investments/macro";
import { expect, it } from "vitest";
import type { InvFxRateRow } from "../../sources/investments.ts";
import { researchMacroCloses } from "./researchSource.ts";

it("adds only stored PLN-per-USD rates through asOf in date order without changing raw facts", () => {
  const rate = (date: string, value: string, base = "PLN", quote = "USD"): InvFxRateRow => ({
    base,
    quote,
    date,
    rate: value,
    source: "nbp",
    fetchedAt: null,
  });
  const closes = { dxy: [["2026-10-01", 100] as const] };
  const rates = [
    rate("2026-10-02", "4.2"),
    rate("2026-10-01", "4.1"),
    rate("2026-10-03", "9"),
    rate("2026-10-01", "8", "EUR"),
    rate("2026-10-01", "7", "PLN", "EUR"),
  ];
  expect(researchMacroCloses(closes, rates, "2026-10-02")).toEqual({
    ...closes,
    [USDPLN]: [
      ["2026-10-01", 4.1],
      ["2026-10-02", 4.2],
    ],
  });
  expect(Object.keys(closes)).toEqual(["dxy"]);
  expect(rates.map((row) => row.date)).toEqual([
    "2026-10-02",
    "2026-10-01",
    "2026-10-03",
    "2026-10-01",
    "2026-10-01",
  ]);
  expect(researchMacroCloses(closes, rates, "2026-09-30")).toBe(closes);
});
