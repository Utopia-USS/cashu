// Python test_rules_allocation_drift, position_concentration, cash_level and tagged_weight.
import { expect, it } from "vitest";
import { AssetClass } from "../../domain/enums.js";
import { cashHistoryGap } from "../../domain/warnings.js";
import { describe, fired, parse, runKind, skipped } from "../testing/evaluate.js";
import {
  ACCOUNT_B,
  AS_OF,
  alloc,
  context,
  d,
  h,
  instrument,
  PLN,
  portfolio,
  USD,
} from "../testing/fixtures.js";
import {
  AllocationDriftParams,
  allocationDriftRule,
  DEFAULT_REBALANCE,
} from "./allocationDrift.js";
import { CashLevelParams, cashLevelRule } from "./cashLevel.js";
import { PositionConcentrationParams, positionConcentrationRule } from "./positionConcentration.js";
import { TaggedWeightParams, taggedWeightRule } from "./taggedWeight.js";

const stock = instrument("PKN", { tags: ["PL", "energy"] });
const etf = instrument("VWCE", { assetClass: AssetClass.ETF });
const cash = instrument("MMF", { assetClass: AssetClass.CASH });
const good = portfolio([h(etf, { value: "100000" })]);

it("negative account cash blocks a cash alert even when aggregate cash is positive", () => {
  const p = portfolio([h(etf, { value: "100000" })], {
    cash: "20000",
    snapshotWarnings: [
      cashHistoryGap({ accountId: ACCOUNT_B, currency: PLN, amount: d("-30000"), asOf: AS_OF }),
    ],
  });
  const result = runKind(
    cashLevelRule,
    context({ portfolioValue: p }),
    new CashLevelParams({ maxWeight: 0.1 }),
  );
  expect(describe(result)).toEqual(["skipped r"]);
  expect(skipped(result[0])).toBe(
    "Niepełna historia gotówki (ujemne saldo: -30\u00a0000 PLN na koncie account-b; brak wpłat w zaimportowanej historii?): udział gotówki nieznany",
  );
});

it("drift fires both directions with exact Polish text and generic bucket metadata", () => {
  const result = runKind(
    allocationDriftRule,
    context({
      portfolioValue: good,
      allocations: [
        alloc("equity", { weight: 0.67, target: 0.6 }),
        alloc("bonds", { weight: 0.33, target: 0.4 }),
      ],
    }),
    new AllocationDriftParams(),
  );
  expect(describe(result)).toEqual(["fired r|s:equity", "fired r|s:bonds"]);
  expect(fired(result[0]).message).toBe(
    "Koszyk equity powyżej celu o 7,0\u00a0pp (67,0\u00a0% wobec 60,0\u00a0%, 7\u00a0000 PLN ponad cel).",
  );
  expect(fired(result[1]).message).toBe(
    "Koszyk bonds poniżej celu o 7,0\u00a0pp (33,0\u00a0% wobec 40,0\u00a0%, do celu brakuje 7\u00a0000 PLN).",
  );
  expect(fired(result[0]).payload).toMatchObject({
    bucket_generic: true,
    drift_value_base: "7000",
    direction: "overweight",
  });
});
it("drift checks relative bands, exact boundaries, minimum trade and zero targets", () => {
  const run = (weight: number, target: number, bands = DEFAULT_REBALANCE) =>
    runKind(
      allocationDriftRule,
      context({ portfolioValue: good, allocations: [alloc("cash", { weight, target })] }),
      new AllocationDriftParams({ bands }),
    );
  expect(describe(run(0.035, 0.05))).toEqual(["fired r|s:cash"]);
  expect(describe(run(0.25, 0.2, { ...DEFAULT_REBALANCE, relativeBand: 10 }))).toEqual([
    "not_fired r|s:cash",
  ]);
  expect(describe(run(0.4, 0.2, { ...DEFAULT_REBALANCE, minTradeValue: d("20001") }))).toEqual([
    "not_fired r|s:cash",
  ]);
  expect(fired(run(0.06, 0)[0]).payload.drift_rel).toBeNull();
});
it("drift respects requested order, missing scopes and per-bucket negative cash", () => {
  const result = runKind(
    allocationDriftRule,
    context({
      portfolioValue: good,
      allocations: [
        alloc("equity", { weight: 0.9, target: 0.6 }),
        alloc("bonds", { weight: 0.1, target: 0.4, cashHistoryGap: true }),
      ],
    }),
    new AllocationDriftParams({ buckets: ["bonds", "gold", "equity"] }),
  );
  expect(describe(result)).toEqual(["skipped r|s:bonds", "skipped r|s:gold", "fired r|s:equity"]);
  expect(skipped(result[1])).toBe("Brak alokacji koszyka gold");
});
it("drift never names a private bucket in owner-facing text", () => {
  const result = runKind(
    allocationDriftRule,
    context({
      portfolioValue: good,
      lang: "en",
      allocations: [alloc("private-plan", { weight: 0.78, target: 0.7 })],
    }),
    new AllocationDriftParams(),
  );
  expect(fired(result[0]).message).toBe(
    "Bucket above the target by 8.0\u00a0pp (78.0% vs 70.0%, 8,000 PLN over the target).",
  );
  expect(fired(result[0]).payload).toMatchObject({
    bucket_id: "private-plan",
    bucket_generic: false,
  });
});
it("concentration sums accounts and applies combined filters", () => {
  const p = portfolio([h(stock), h(stock, { account: ACCOUNT_B }), h(etf, { value: "8000" })]);
  const params = parse(positionConcentrationRule, {
    max_weight: 0.1,
    asset_class: "equity",
    tags: ["pl", "energy"],
    instrument_ids: [stock.id, etf.id],
  });
  const result = runKind(positionConcentrationRule, context({ portfolioValue: p }), params);
  expect(describe(result)).toEqual(["fired r|i:i-PKN"]);
  expect(fired(result[0]).message).toBe("PKN: 20,0\u00a0% portfela (maks 10,0\u00a0%).");
  expect(fired(result[0]).payload.accounts).toBe(2);
});
it("concentration is quiet at the limit and excludes cash unless explicitly selected", () => {
  const ctx = context({ portfolioValue: portfolio([h(cash, { value: "9000" }), h(stock)]) });
  expect(
    describe(
      runKind(positionConcentrationRule, ctx, new PositionConcentrationParams({ maxWeight: 0.1 })),
    ),
  ).toEqual(["not_fired r|i:i-PKN"]);
  expect(
    describe(
      runKind(
        positionConcentrationRule,
        ctx,
        parse(positionConcentrationRule, { max_weight: 0.1, asset_class: "cash" }),
      ),
    ),
  ).toEqual(["fired r|i:i-MMF"]);
  expect(
    runKind(
      positionConcentrationRule,
      ctx,
      parse(positionConcentrationRule, { max_weight: 0.1, tags: "absent" }),
    ),
  ).toEqual([]);
});
it("concentration skips only one stale instrument when total stale weight is acceptable", () => {
  const result = runKind(
    positionConcentrationRule,
    context({
      portfolioValue: portfolio([
        h(stock, { value: "200", stale: true }),
        h(etf, { value: "9800" }),
      ]),
    }),
    new PositionConcentrationParams({ maxWeight: 0.1 }),
  );
  expect(describe(result)).toEqual(["skipped r|i:i-PKN", "fired r|i:i-VWCE"]);
  expect(skipped(result[0])).toBe("Nieaktualna cena: PKN (ostatnie zamknięcie 2026-09-22)");
});
it("cash includes cash-like instruments and preserves exact high/low/inside messages", () => {
  const params = new CashLevelParams({ minWeight: 0.02, maxWeight: 0.15 });
  const high = runKind(
    cashLevelRule,
    context({ portfolioValue: portfolio([h(etf, { value: "8000" }), h(cash)], { cash: "1000" }) }),
    params,
  );
  expect(fired(high[0]).message).toBe(
    "Gotówka: 20,0\u00a0% portfela, powyżej maksimum 15,0\u00a0%.",
  );
  expect(fired(high[0]).payload.cash_base).toBe("2000");
  const low = runKind(
    cashLevelRule,
    context({ portfolioValue: portfolio([h(etf, { value: "9900" })], { cash: "100" }) }),
    params,
  );
  expect(fired(low[0]).message).toBe("Gotówka: 1,0\u00a0% portfela, poniżej minimum 2,0\u00a0%.");
  expect(
    describe(
      runKind(
        cashLevelRule,
        context({ portfolioValue: portfolio([h(etf, { value: "9000" })], { cash: "1000" }) }),
        params,
      ),
    ),
  ).toEqual(["not_fired r"]);
});
it("tagged weight requires every tag, sums across accounts and sorts unique labels", () => {
  const other = instrument("ABC", { tags: ["pl", "energy"] });
  const p = portfolio([
    h(stock, { value: "2000" }),
    h(stock, { account: ACCOUNT_B, value: "2000" }),
    h(other, { value: "2000" }),
    h(etf, { value: "4000" }),
  ]);
  const params = new TaggedWeightParams({ tags: ["PL", "energy"], maxWeight: 0.3 });
  const result = runKind(taggedWeightRule, context({ portfolioValue: p, lang: "en" }), params);
  expect(fired(result[0]).payload).toEqual({
    tags: ["PL", "energy"],
    weight: 0.6000000000000001,
    max_weight: 0.3,
    instruments: ["ABC", "PKN"],
  });
  expect(fired(result[0]).message).toBe(
    "Positions tagged PL, energy: 60.0% of the portfolio (max 30.0%): ABC, PKN.",
  );
  expect(
    describe(
      runKind(
        taggedWeightRule,
        context({ portfolioValue: p }),
        new TaggedWeightParams({ tags: ["PL", "missing"], maxWeight: 0.3 }),
      ),
    ),
  ).toEqual(["not_fired r"]);
});
it.each(["empty", "stale", "unpriced", "fx"])(
  "weight rules all refuse %s portfolio data",
  (problem) => {
    const p =
      problem === "empty"
        ? portfolio()
        : problem === "stale"
          ? portfolio([h(stock, { stale: true })])
          : problem === "unpriced"
            ? portfolio([h(stock, { value: null })])
            : portfolio([h(stock)], { missingFxCurrencies: new Set([USD]) });
    const ctx = context({
      portfolioValue: p,
      allocations: [alloc("equity", { weight: 1, target: 0.5 })],
    });
    const results = [
      runKind(allocationDriftRule, ctx, new AllocationDriftParams()),
      runKind(cashLevelRule, ctx, new CashLevelParams({ maxWeight: 0.1 })),
      runKind(taggedWeightRule, ctx, new TaggedWeightParams({ tags: ["PL"], maxWeight: 0.1 })),
    ];
    for (const result of results) expect(describe(result)).toEqual(["skipped r"]);
  },
);
it("unclassified share blocks drift and tagged weights; missing allocation has its own reason", () => {
  const p = portfolio([h(stock)]);
  const ctx = context({
    portfolioValue: p,
    allocations: [alloc("equity", { weight: 1, target: 0.5 })],
    unclassified: p.valued,
  });
  expect(skipped(runKind(allocationDriftRule, ctx, new AllocationDriftParams())[0])).toContain(
    "Pozycje bez koszyka",
  );
  expect(
    skipped(
      runKind(taggedWeightRule, ctx, new TaggedWeightParams({ tags: ["PL"], maxWeight: 0.1 }))[0],
    ),
  ).toContain("Pozycje bez koszyka");
  expect(
    skipped(
      runKind(
        allocationDriftRule,
        context({ portfolioValue: good }),
        new AllocationDriftParams(),
      )[0],
    ),
  ).toBe("Brak wyliczonej alokacji koszyków");
});
