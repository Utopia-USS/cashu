// Python test_rules_custom.py, bucket_names.py and English/Polish message contracts.
// Engine -> persisted signal lifecycle scenarios remain explicitly in T19.
import { expect, it } from "vitest";
import { AssetClass } from "../../domain/enums.js";
import { NotFired } from "../outcomes.js";
import { describe, fired, parse, runKind, skipped } from "../testing/evaluate.js";
import { alloc, bars, context, day, h, instrument, portfolio } from "../testing/fixtures.js";
import { CustomParams, customRule } from "./custom.js";

const etf = instrument("VWCE", { assetClass: AssetClass.ETF });
const stock = instrument("PKN", { tags: ["satellite"] });
const other = instrument("CDR", { tags: ["satellite"] });
const params = (when: string, raw = {}) => parse(customRule, { when, ...raw });
it("portfolio conditions carry normalized text, exact measured values and custom message", () => {
  const p = portfolio([h(etf, { value: "8000" })], { cash: "2000", deposits: [day("2026-09-01")] });
  const result = runKind(
    customRule,
    context({ portfolioValue: p }),
    params("cash_weight >= 15% and days_since_last_deposit <= 45", { message: "Invest the cash" }),
  );
  expect(fired(result[0]).message).toBe(
    "Invest the cash (cash_weight 20,0\u00a0%, days_since_last_deposit 31).",
  );
  expect(fired(result[0]).payload).toEqual({
    scope: "portfolio",
    when: "cash_weight >= 15% and days_since_last_deposit <= 45",
    values: { cash_weight: 0.2, days_since_last_deposit: 31 },
  });
});
it.each(["pl", "en"] as const)("default message and NotFired measured values use %s", (lang) => {
  const ctx = context({
    portfolioValue: portfolio([h(etf, { value: "9000" })], { cash: "1000" }),
    lang,
  });
  expect(fired(runKind(customRule, ctx, params("total_value  >=  10000"))[0]).message).toBe(
    lang === "pl"
      ? "Warunek spełniony: total_value >= 10000 (total_value 10\u00a0000 PLN)."
      : "Condition met: total_value >= 10000 (total_value 10,000 PLN).",
  );
  const quiet = runKind(customRule, ctx, params("cash_weight > 50%"));
  expect(quiet[0]).toEqual(
    new NotFired("r", "r", {
      scope: "portfolio",
      when: "cash_weight > 50%",
      values: { cash_weight: 0.1 },
    }),
  );
});
it("unknown data skips, while decisive Kleene false retains null measured values", () => {
  const ctx = context({
    portfolioValue: portfolio([h(etf, { value: "9000", stale: true })], { cash: "1000" }),
  });
  expect(skipped(runKind(customRule, ctx, params("cash_weight < 50%"))[0])).toBe(
    "Nieaktualne ceny: 90,0\u00a0% portfela (maks 5,0\u00a0%)",
  );
  expect(
    describe(runKind(customRule, ctx, params("cash_weight < 50% and total_value > 1000000"))),
  ).toEqual(["skipped r"]);
  const decided = runKind(customRule, ctx, params("cash_weight < 50% and stale_weight < 10%"));
  expect(decided[0]).toEqual(
    new NotFired("r", "r", {
      scope: "portfolio",
      when: "cash_weight < 50% and stale_weight < 10%",
      values: { cash_weight: null, stale_weight: 0.9 },
    }),
  );
  const hit = fired(runKind(customRule, ctx, params("cash_weight < 50% or stale_weight > 10%"))[0]);
  expect(hit.message).toContain("cash_weight nieznane");
});
it("instrument scopes keep filters, exact ids, payload and label prefixes", () => {
  const ctx = context({
    portfolioValue: portfolio([
      h(etf, { value: "7000", cost: "5000" }),
      h(stock, { value: "2000", cost: "4000" }),
      h(other, { value: "1000", cost: "900" }),
    ]),
  });
  const result = runKind(
    customRule,
    ctx,
    params("unrealized_pct <= -25% and weight < 30%", {
      scope: "instrument",
      tags: ["satellite"],
      message: "Review the thesis",
    }),
  );
  expect(describe(result)).toEqual(["fired r|i:i-PKN", "not_fired r|i:i-CDR"]);
  expect(fired(result[0]).instrumentId).toBe(stock.id);
  expect(fired(result[0]).message).toBe(
    "PKN: Review the thesis (unrealized_pct -50,0\u00a0%, weight 20,0\u00a0%).",
  );
  expect(fired(result[0]).payload).toMatchObject({
    symbol: "PKN",
    values: { unrealized_pct: -0.5, weight: 0.2 },
  });
});
it("price-series and text metrics are real, with per-instrument unknowns", () => {
  const ctx = context({
    portfolioValue: portfolio([h(etf, { value: "6000" }), h(stock, { value: "4000" })]),
    series: new Map([[etf, bars(etf, ["100", "100", "100", "100", "70"])]]),
  });
  const result = runKind(
    customRule,
    ctx,
    params("drawdown_from_high(5) >= 20%", { scope: "instrument" }),
  );
  expect(describe(result)).toEqual(["fired r|i:i-VWCE", "skipped r|i:i-PKN"]);
  expect(fired(result[0]).message).toBe(
    "VWCE: Warunek spełniony: drawdown_from_high(5) >= 20% (drawdown_from_high(5) 30,0\u00a0%).",
  );
  expect(skipped(result[1])).toBe("Brak notowań: PKN");
  expect(
    describe(
      runKind(
        customRule,
        ctx,
        params('asset_class == "equity" and weight > 30%', { scope: "instrument" }),
      ),
    ),
  ).toEqual(["not_fired r|i:i-VWCE", "fired r|i:i-PKN"]);
});
it("an empty instrument scope emits no outcomes and an uncompiled expression skips", () => {
  expect(runKind(customRule, context(), params("weight > 1%", { scope: "instrument" }))).toEqual(
    [],
  );
  expect(skipped(runKind(customRule, context(), new CustomParams({ expression: null }))[0])).toBe(
    "Nie udało się skompilować warunku reguły",
  );
});
const allocations = [
  alloc("equity", { weight: 0.78, target: 0.7 }),
  alloc("bonds", { weight: 0.12, target: 0.2 }),
  alloc("cash", { weight: 0.1, target: 0.1 }),
];
const value = portfolio([h(etf, { value: "100000" })]);
it.each(["pl", "en"] as const)("bucket scope evaluates every bucket with %s messages", (lang) => {
  const result = runKind(
    customRule,
    context({ portfolioValue: value, allocations, lang }),
    params("drift_pp <= -5 or drift_pp >= 5", { scope: "bucket" }),
  );
  expect(describe(result)).toEqual(["fired r|s:equity", "fired r|s:bonds", "not_fired r|s:cash"]);
  expect(fired(result[1]).payload.bucket_id).toBe("bonds");
  expect(fired(result[1]).message).toBe(
    lang === "pl"
      ? "Koszyk bonds: Warunek spełniony: drift_pp <= -5 or drift_pp >= 5 (drift_pp -8,0\u00a0pp)."
      : "Bucket bonds: Condition met: drift_pp <= -5 or drift_pp >= 5 (drift_pp -8.0\u00a0pp).",
  );
});
it("missing bucket scopes, missing allocation and unclassified holdings have precise skip scopes", () => {
  const subset = runKind(
    customRule,
    context({ portfolioValue: value, allocations }),
    params("drift_value < -5000", { scope: "bucket", buckets: ["bonds", "gold"] }),
  );
  expect(describe(subset)).toEqual(["fired r|s:bonds", "skipped r|s:gold"]);
  expect(skipped(subset[1])).toBe("Brak alokacji koszyka gold");
  expect(
    skipped(
      runKind(
        customRule,
        context({ portfolioValue: value }),
        params("drift_pp > 1", { scope: "bucket" }),
      )[0],
    ),
  ).toBe("Brak wyliczonej alokacji koszyków");
  const missing = runKind(
    customRule,
    context({ portfolioValue: value, allocations, unclassified: value.valued }),
    params("weight > target", { scope: "bucket" }),
  );
  expect(describe(missing)).toEqual([
    "skipped r|s:equity",
    "skipped r|s:bonds",
    "skipped r|s:cash",
  ]);
});
it("private bucket ids remain in payloads but not generic owner-facing messages", () => {
  const ctx = context({
    portfolioValue: value,
    allocations: [
      alloc("core", { weight: 0.78, target: 0.7 }),
      alloc("bonds", { weight: 0.22, target: 0.3 }),
    ],
  });
  const scoped = runKind(
    customRule,
    ctx,
    params("drift_pp >= 5 or drift_pp <= -5", { scope: "bucket" }),
  );
  expect(fired(scoped[0]).message).toBe(
    "Warunek spełniony: drift_pp >= 5 or drift_pp <= -5 (drift_pp 8,0\u00a0pp).",
  );
  expect(fired(scoped[0]).payload.bucket_id).toBe("core");
  const own = fired(
    runKind(customRule, ctx, params('bucket_weight("core") > 50% and holdings_count >= 1'))[0],
  );
  expect(own.message).toBe("Warunek spełniony (holdings_count 1).");
  expect(own.payload).toMatchObject({
    when: 'bucket_weight("core") > 50% and holdings_count >= 1',
    values: { 'bucket_weight("core")': 0.78 },
  });
  expect(fired(runKind(customRule, ctx, params('bucket_weight("bonds") > 5%'))[0]).message).toBe(
    'Warunek spełniony: bucket_weight("bonds") > 5% (bucket_weight("bonds") 22,0\u00a0%).',
  );
});
