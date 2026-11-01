// Python test_rules_loss_from_cost, gain_from_cost and drawdown_from_high.
import { expect, it } from "vitest";
import { AssetClass } from "../../domain/enums.js";
import { describe, fired, parse, runKind, skipped } from "../testing/evaluate.js";
import {
  ACCOUNT_B,
  bars,
  context,
  day,
  h,
  instrument,
  portfolio,
  USD,
} from "../testing/fixtures.js";
import { DrawdownFromHighParams, drawdownFromHighRule } from "./drawdownFromHigh.js";
import {
  gainFromCostRule,
  lossFromCostRule,
  UnrealizedThresholdParams,
} from "./unrealizedFromCost.js";

const stock = instrument("PKN", { tags: ["satellite"] });
const other = instrument("CDR");

it("loss threshold includes equality and aggregates account values before comparing", () => {
  const ctx = context({
    portfolioValue: portfolio([
      h(stock, { value: "600", cost: "1000" }),
      h(stock, { value: "900", cost: "1000", account: ACCOUNT_B }),
      h(other, { value: "800", cost: "1000" }),
    ]),
  });
  const result = runKind(lossFromCostRule, ctx, new UnrealizedThresholdParams({ threshold: 0.25 }));
  expect(describe(result)).toEqual(["fired r|i:i-PKN", "not_fired r|i:i-CDR"]);
  expect(fired(result[0]).message).toBe("PKN: -25,0\u00a0% od kosztu (próg -25,0\u00a0%).");
  expect(fired(result[0]).payload).toMatchObject({
    market_value_base: "1500",
    cost_basis_base: "2000",
  });
});
it("gain permits thresholds above one and respects filters and below-threshold outcomes", () => {
  const ctx = context({
    portfolioValue: portfolio([
      h(stock, { value: "2500", cost: "1000" }),
      h(other, { value: "2000", cost: "1000" }),
    ]),
    lang: "en",
  });
  const params = parse(gainFromCostRule, { threshold: 1.5 });
  const result = runKind(gainFromCostRule, ctx, params);
  expect(describe(result)).toEqual(["fired r|i:i-PKN", "not_fired r|i:i-CDR"]);
  expect(fired(result[0]).message).toBe("PKN: +150.0% from cost (threshold +150.0%).");
  expect(
    describe(
      runKind(
        gainFromCostRule,
        ctx,
        parse(gainFromCostRule, { threshold: 1.5, tags: "satellite" }),
      ),
    ),
  ).toEqual(["fired r|i:i-PKN"]);
});
it.each([lossFromCostRule, gainFromCostRule])(
  "$kind skips stale/missing price, unknown/zero cost and manual values in precedence order",
  (kind) => {
    const p = portfolio([
      h(stock, { stale: true }),
      h(other, { value: null }),
      h(instrument("UNKNOWN"), { cost: null }),
      h(instrument("ZERO"), { cost: "0" }),
      h(instrument("MANUAL"), { value: "0", manual: true }),
    ]);
    const results = runKind(
      kind,
      context({ portfolioValue: p }),
      new UnrealizedThresholdParams({ threshold: 0.25 }),
    );
    expect(results.map((o) => o.type)).toEqual(Array(5).fill("skipped"));
    expect(skipped(results[0])).toBe("Nieaktualna cena: PKN (ostatnie zamknięcie 2026-09-22)");
    expect(skipped(results[1])).toBe("Brak ceny: CDR");
    expect(skipped(results[2])).toContain("Nieznany koszt: UNKNOWN");
    expect(skipped(results[3])).toBe("Zerowy koszt: ZERO");
    expect(skipped(results[4])).toContain("wycena ręczna");
  },
);
it("cost valuation remains evaluable but missing FX skips only its affected position", () => {
  const usd = instrument("AAPL", { currency: USD });
  const ctx = context({
    portfolioValue: portfolio([h(stock, { value: "1000", cost: "1000", atCost: true }), h(usd)], {
      missingFxCurrencies: new Set([USD]),
    }),
  });
  const result = runKind(lossFromCostRule, ctx, new UnrealizedThresholdParams({ threshold: 0.25 }));
  expect(describe(result)).toEqual(["not_fired r|i:i-PKN", "skipped r|i:i-AAPL"]);
  expect(skipped(result[1])).toBe("Brak kursu USD: nie da się wycenić AAPL");
});
const params = new DrawdownFromHighParams({ threshold: 0.15, windowDays: 5 });
it("drawdown uses last close versus first matching window high with exact message", () => {
  const ctx = context({
    portfolioValue: portfolio([h(stock), h(other)]),
    series: new Map([
      [stock, bars(stock, ["90", "100", "95", "85", "80"])],
      [other, bars(other, ["100", "100", "100", "95", "90"])],
    ]),
  });
  const result = runKind(drawdownFromHighRule, ctx, params);
  expect(describe(result)).toEqual(["fired r|i:i-PKN", "not_fired r|i:i-CDR"]);
  expect(fired(result[0]).message).toBe(
    "PKN: -20,0\u00a0% od szczytu z 5 sesji (zamknięcie 80 2026-10-02, szczyt 100 2026-09-29; próg -15,0\u00a0%).",
  );
  expect(fired(result[0]).payload).toMatchObject({ drawdown: 0.2, high_date: "2026-09-29" });
});
it("drawdown includes exact threshold, ignores older highs and excludes cash by default", () => {
  const cash = instrument("MMF", { assetClass: AssetClass.CASH });
  const ctx = context({
    portfolioValue: portfolio([h(stock), h(cash)]),
    series: new Map([
      [stock, bars(stock, ["200", "100", "95", "90", "88", "85"])],
      [cash, bars(cash, ["100", "100", "100", "100", "50"])],
    ]),
  });
  const result = runKind(drawdownFromHighRule, ctx, params);
  expect(describe(result)).toEqual(["fired r|i:i-PKN"]);
  expect(fired(result[0]).payload.high_close).toBe("100");
  const onlyCash = parse(drawdownFromHighRule, {
    threshold: 0.15,
    window_days: 5n,
    asset_class: "cash",
  });
  expect(describe(runKind(drawdownFromHighRule, ctx, onlyCash))).toEqual(["fired r|i:i-MMF"]);
});
it.each(["missing", "short", "stale", "invalid", "manual", "cost", "fx"])(
  "drawdown refuses %s inputs",
  (mode) => {
    const inst = instrument("ASSET", { currency: mode === "fx" ? USD : undefined });
    const p = portfolio([h(inst, { manual: mode === "manual", atCost: mode === "cost" })], {
      missingFxCurrencies: new Set(mode === "fx" ? [USD] : []),
    });
    const series =
      mode === "missing"
        ? new Map()
        : new Map([
            [
              inst,
              bars(
                inst,
                mode === "short"
                  ? ["100"]
                  : mode === "invalid"
                    ? ["100", "0", "100", "100", "50"]
                    : ["100", "100", "100", "100", "50"],
                mode === "stale" ? day("2026-09-20") : undefined,
              ),
            ],
          ]);
    expect(
      describe(runKind(drawdownFromHighRule, context({ portfolioValue: p, series }), params)),
    ).toEqual(["skipped r|i:i-ASSET"]);
  },
);
it("one manual account makes the aggregated instrument unsuitable for drawdown", () => {
  const ctx = context({
    portfolioValue: portfolio([h(stock), h(stock, { account: ACCOUNT_B, manual: true })]),
    series: new Map([[stock, bars(stock, ["100", "100", "100", "100", "50"])]]),
  });
  expect(skipped(runKind(drawdownFromHighRule, ctx, params)[0])).toContain("wycena ręczna");
});
