// tests/investments/rules/test_rules_expr_metrics.py: all metrics, real synthetic contexts and quality gates.
import { describe, expect, it } from "vitest";
import { D, Decimal } from "../../../decimal.js";
import { ASSET_CLASSES, AssetClass } from "../../domain/enums.js";
import { asAccountId } from "../../domain/values.js";
import { buildRuleContext, type RuleContext } from "../context.js";
import { DEFAULT_DATA_QUALITY } from "../kind.js";
import { positionsByInstrument } from "../positions.js";
import {
  ACCOUNT_A,
  ACCOUNT_B,
  AS_OF,
  alloc,
  bars,
  context,
  day,
  h,
  instrument,
  PLN,
  portfolio,
  USD,
} from "../testing/fixtures.js";
import { METRICS } from "./catalog.js";
import { Unknown, type Value } from "./evaluator.js";
import { MetricEnv } from "./metrics.js";

const ETF = instrument("VWCE", {
  assetClass: AssetClass.ETF,
  tags: ["core", "global_equity"],
  mic: "xetr",
});
const PKN = instrument("PKN", { tags: ["satellite"] });
const BOND = instrument("EDO0536", { assetClass: AssetClass.TREASURY_BOND, mic: null });
const MMF = instrument("MMF", { assetClass: AssetClass.CASH });
const specs = [
  h(ETF, { value: "6000", cost: "5000" }),
  h(PKN, { value: "1500", cost: "2000" }),
  h(BOND, { value: "1000", cost: "1000", atCost: true }),
  h(MMF, { value: "500", cost: "500" }),
];
const allocations = [
  alloc("equity", { weight: 0.75, target: 0.7, total: 10000 }),
  alloc("bonds", { weight: 0.1, target: 0.2, total: 10000 }),
  alloc("cash", { weight: 0.15, target: 0.1, total: 10000 }),
  alloc("gold", { weight: 0.02, target: 0, total: 10000 }),
];
const ctx = context({
  portfolioValue: portfolio(specs, {
    cash: "1000",
    deposits: [day("2026-09-01"), day("2026-08-01")],
  }),
  allocations,
  series: new Map([[ETF, bars(ETF, ["100", "120", "110", "90", "96"])]]),
  contributions: { monthlyAmount: D("1500"), dayOfMonth: null },
});
function envFor(c: RuleContext = ctx, symbol?: string, bucketId?: string): MetricEnv {
  if (symbol !== undefined) {
    const p = positionsByInstrument(c, {
      assetClasses: new Set(ASSET_CLASSES),
      tags: [],
      instrumentIds: new Set(),
    }).find((p) => p.label === symbol);
    if (!p) throw new Error(`missing synthetic position ${symbol}`);
    return new MetricEnv(c, { position: p });
  }
  return new MetricEnv(
    c,
    bucketId === undefined
      ? {}
      : { bucketId, allocation: c.allocations.find((a) => a.bucketId === bucketId) },
  );
}
function value(name: string, args: readonly (string | number)[] = [], env = envFor()): Value {
  return env.resolve({ name, args, column: 1 });
}
function decimal(result: Value, expected: string): void {
  expect(result).toBeInstanceOf(Decimal);
  expect((result as Decimal).sub(D(expected)).abs().lt(D("1e-9"))).toBe(true);
}
function reasons(result: Value): string {
  expect(result).toBeInstanceOf(Unknown);
  return (result as Unknown).reasons.join("; ");
}
describe("all 35 metric resolvers", () => {
  it("computes every portfolio, instrument and bucket metric on good data", () => {
    const checked = new Set<string>();
    const check = (
      name: string,
      expected: string,
      args: readonly (string | number)[] = [],
      env = envFor(),
    ) => {
      checked.add(name);
      decimal(value(name, args, env), expected);
    };
    for (const [name, expected] of Object.entries({
      total_value: "10000",
      cash_value: "1500",
      cash_weight: "0.15",
      stale_weight: "0",
      unclassified_weight: "0",
      max_position_weight: "0.6",
      holdings_count: "3",
      days_since_last_deposit: "31",
      monthly_contribution: "1500",
    }))
      check(name, expected);
    check("bucket_weight", ".75", ["equity"]);
    check("bucket_target", ".2", ["bonds"]);
    check("bucket_drift_pp", "-10", ["bonds"]);
    check("bucket_value", "1500", ["cash"]);
    check("tagged_weight", ".6", ["core"]);
    check("asset_class_weight", ".15", ["cash"]);
    const e = envFor(ctx, "VWCE");
    const p = envFor(ctx, "PKN");
    for (const [name, expected] of Object.entries({
      symbol: "VWCE",
      asset_class: "etf",
      currency: "PLN",
      mic: "XETR",
    })) {
      checked.add(name);
      expect(value(name, [], e)).toBe(expected);
    }
    for (const [name, expected] of Object.entries({
      weight: ".15",
      market_value: "1500",
      cost_basis: "2000",
      unrealized_pct: "-.25",
      unrealized_value: "-500",
    }))
      check(name, expected, [], p);
    check("last_close", "96", [], e);
    check("drawdown_from_high", ".2", [5], e);
    check("price_change", "-.04", [5], e);
    check("price_vs_sma", D("96").div(D("103.2")).sub(D("1")).toString(), [5], e);
    checked.add("holding_has_tag");
    expect(value("holding_has_tag", ["Core"], e)).toBe(true);
    expect(value("holding_has_tag", ["satellite"], e)).toBe(false);
    const b = envFor(ctx, undefined, "bonds");
    checked.add("bucket_id");
    expect(value("bucket_id", [], b)).toBe("bonds");
    for (const [name, expected] of Object.entries({
      weight: ".1",
      target: ".2",
      drift_pp: "-10",
      drift_rel: "-.5",
      value: "1000",
      drift_value: "-1000",
    }))
      check(name, expected, [], b);
    expect([...checked].sort()).toEqual([...METRICS.keys()].sort());
  });
  it("skips stale portfolio values but still reads targets, counts and stale share", () => {
    const c = context({
      portfolioValue: portfolio([
        h(ETF, { value: "9000", stale: true }),
        h(PKN, { value: "1000" }),
      ]),
      allocations,
    });
    const env = envFor(c);
    for (const name of [
      "total_value",
      "cash_value",
      "cash_weight",
      "max_position_weight",
      "tagged_weight",
      "bucket_weight",
      "asset_class_weight",
    ])
      expect(reasons(value(name, [name === "asset_class_weight" ? "etf" : "equity"], env))).toBe(
        "Nieaktualne ceny: 90,0\u00a0% portfela (maks. 5,0\u00a0%)",
      );
    decimal(value("stale_weight", [], env), ".9");
    decimal(value("bucket_target", ["equity"], env), ".7");
    decimal(value("holdings_count", [], env), "2");
    for (const name of ["weight", "drift_pp", "drift_rel", "value", "drift_value"])
      expect(reasons(value(name, [], envFor(c, undefined, "bonds")))).toContain("Nieaktualne ceny");
    decimal(value("target", [], envFor(c, undefined, "bonds")), ".2");
  });
  it("distinguishes empty known amounts, missing FX and cash history gaps", () => {
    decimal(value("total_value", [], envFor(context())), "0");
    decimal(value("holdings_count", [], envFor(context())), "0");
    expect(reasons(value("cash_weight", [], envFor(context())))).toBe(
      "Portfel nie ma jeszcze wartości",
    );
    const usd = instrument("VT", { currency: USD });
    const c = context({
      portfolioValue: portfolio([h(usd)], { missingFxCurrencies: new Set([USD]) }),
      series: new Map([[usd, bars(usd, ["1", "2"])]]),
    });
    expect(reasons(value("total_value", [], envFor(c)))).toContain("Brak kursu USD/PLN");
    expect(reasons(value("last_close", [], envFor(c, "VT")))).toBe(
      "Brak kursu USD: nie da się wycenić VT",
    );
    const gap = context({
      portfolioValue: portfolio(specs, {
        cash: "1000",
        snapshotWarnings: [
          {
            kind: "cash_history_gap",
            accountId: asAccountId("a"),
            currency: PLN,
            amount: D("-50"),
            asOf: AS_OF,
          },
        ],
      }),
    });
    for (const name of ["cash_weight", "cash_value", "asset_class_weight"])
      expect(reasons(value(name, ["cash"], envFor(gap)))).toContain("Niepełna historia gotówki");
    decimal(value("asset_class_weight", ["etf"], envFor(gap)), ".6");
  });
  it("preserves bucket classification, unknown names, cash gaps and zero-target rules", () => {
    const c = context({ portfolioValue: portfolio(specs, { cash: "1000" }) });
    for (const name of ["bucket_weight", "unclassified_weight"])
      expect(reasons(value(name, ["equity"], envFor(c)))).toBe("Brak wyliczonej alokacji koszyków");
    expect(reasons(value("bucket_weight", ["owner private"]))).toBe("Brak alokacji koszyka");
    expect(reasons(value("bucket_weight", ["crypto"]))).toBe("Brak alokacji koszyka crypto");
    const p = portfolio([...specs, h(instrument("NEW"), { value: "3000" })], { cash: "1000" });
    const last = p.valued[p.valued.length - 1];
    if (last === undefined) throw new Error("missing synthetic holding");
    const unclassified = context({
      portfolioValue: p,
      allocations,
      unclassified: [last],
    });
    expect(reasons(value("bucket_drift_pp", ["equity"], envFor(unclassified)))).toContain(
      "Pozycje bez koszyka: 23,1\u00a0%",
    );
    expect(reasons(value("tagged_weight", ["core"], envFor(unclassified)))).toContain(
      "Pozycje bez koszyka",
    );
    decimal(value("unclassified_weight", [], envFor(unclassified)), String(3000 / 13000));
    const cash = context({
      portfolioValue: c.portfolio,
      allocations: [alloc("cash", { weight: 0.1, target: 0.1, cashHistoryGap: true })],
    });
    expect(reasons(value("bucket_weight", ["cash"], envFor(cash)))).toBe(
      "Koszyk cash: ujemna gotówka (brak wpłat w zaimportowanej historii), wartość nieznana",
    );
    expect(reasons(value("drift_rel", [], envFor(ctx, undefined, "gold")))).toBe(
      "Względny dryf koszyka gold nieokreślony (docelowy udział 0)",
    );
    decimal(value("drift_pp", [], envFor(ctx, undefined, "gold")), "2");
  });
  it("reports absent deposits and contribution plan independently", () => {
    const env = envFor(context({ portfolioValue: portfolio(specs) }));
    expect(reasons(value("days_since_last_deposit", [], env))).toBe("Brak zapisanych wpłat");
    expect(reasons(value("monthly_contribution", [], env))).toBe("Strategia nie ma planu wpłat");
  });
  it("reports a small stale position even when portfolio-wide quality is acceptable", () => {
    const c = context({
      portfolioValue: portfolio([h(ETF, { value: "9900" }), h(PKN, { value: "100", stale: true })]),
    });
    const reason = "Nieaktualna cena: PKN (ostatnie zamknięcie 2026-09-22)";
    expect(reasons(value("max_position_weight", [], envFor(c)))).toBe(reason);
    for (const name of ["weight", "market_value", "unrealized_pct", "unrealized_value"])
      expect(reasons(value(name, [], envFor(c, "PKN")))).toBe(reason);
  });
  it("distinguishes cost, manual valuations and known manual values", () => {
    const unknown = envFor(context({ portfolioValue: portfolio([h(PKN, { cost: null })]) }), "PKN");
    for (const name of ["cost_basis", "unrealized_pct", "unrealized_value"])
      expect(reasons(value(name, [], unknown))).toContain("Nieznany koszt: PKN");
    const zero = envFor(context({ portfolioValue: portfolio([h(PKN, { cost: "0" })]) }), "PKN");
    expect(reasons(value("unrealized_pct", [], zero))).toBe("Zerowy koszt: PKN");
    const frozen = instrument("FTX");
    const manual = envFor(
      context({
        portfolioValue: portfolio([h(frozen, { value: "0", cost: "3000", manual: true })], {
          cash: "1000",
        }),
      }),
      "FTX",
    );
    for (const name of ["unrealized_pct", "unrealized_value"])
      expect(reasons(value(name, [], manual))).toBe(
        "FTX: wycena ręczna, zmiana od kosztu nie jest wynikiem rynkowym",
      );
    expect(reasons(value("drawdown_from_high", [2], manual))).toBe(
      "FTX: wycena ręczna, brak notowań rynkowych",
    );
    decimal(value("market_value", [], manual), "0");
    decimal(value("weight", [], manual), "0");
    decimal(value("cost_basis", [], manual), "3000");
    expect(value("asset_class", [], envFor(ctx, "MMF"))).toBe("cash");
    expect(reasons(value("mic", [], envFor(ctx, "EDO0536")))).toBe(
      "EDO0536: brak kodu giełdy (mic)",
    );
  });
  it("checks windows in Python reason order and uses Decimal series formulas", () => {
    const e = envFor(ctx, "VWCE");
    decimal(value("drawdown_from_high", [2], e), "0");
    expect(reasons(value("drawdown_from_high", [10], e))).toBe("Tylko 5 z 10 notowań: VWCE");
    expect(reasons(value("price_change", [6], e))).toBe("Tylko 5 z 6 notowań: VWCE");
    expect(reasons(value("last_close", [], envFor(ctx, "PKN")))).toBe("Brak notowań: PKN");
    expect(reasons(value("drawdown_from_high", [5], envFor(ctx, "EDO0536")))).toBe(
      "EDO0536: wycena po koszcie, brak notowań rynkowych",
    );
    const old = context({
      portfolioValue: portfolio(specs),
      series: new Map([[ETF, bars(ETF, ["100", "90"], day("2026-09-20"))]]),
    });
    expect(reasons(value("price_vs_sma", [2], envFor(old, "VWCE")))).toBe(
      "Nieaktualna cena: VWCE (ostatnie zamknięcie 2026-09-20, 12 dni temu)",
    );
    decimal(
      value(
        "price_change",
        [2],
        envFor({ ...old, data: { ...DEFAULT_DATA_QUALITY, maxPriceAgeDays: 14 } }, "VWCE"),
      ),
      "-.1",
    );
    const bad = {
      ...old,
      market: { ...old.market, bars: new Map([[ETF.id, bars(ETF, ["100", "0"])]]) },
    };
    expect(reasons(value("price_change", [2], envFor(bad, "VWCE")))).toBe(
      "Nieprawidłowe ceny: VWCE",
    );
  });
  it("aggregates duplicate instruments across accounts in first-seen order without including cash by default", () => {
    const c = context({
      portfolioValue: portfolio([
        h(PKN, { value: "500", account: ACCOUNT_B }),
        h(ETF),
        h(PKN, { value: "1500", account: ACCOUNT_A }),
        h(MMF),
      ]),
    });
    const positions = positionsByInstrument(c);
    expect(positions.map((p) => p.label)).toEqual(["PKN", "VWCE"]);
    expect(positions[0]?.payload().accounts).toBe(2);
    const total = positions[0]?.marketValueBase;
    if (total === null || total === undefined) throw new Error("missing synthetic market value");
    decimal(total, "2000");
    decimal(value("holdings_count", [], envFor(c)), "2");
  });
  it("keeps large monetary values exact and exposes explicit English context defaults", () => {
    const huge = "9007199254740993123456789.12";
    const p = portfolio([h(PKN, { value: huge, cost: "1" })]);
    expect(value("market_value", [], envFor(context({ portfolioValue: p }), "PKN"))).toEqual(
      D(huge),
    );
    const en = buildRuleContext({
      profileId: ctx.profileId,
      asOf: ctx.asOf,
      portfolio: portfolio(),
      market: ctx.market,
    });
    expect(en.lang).toBe("en");
    expect(reasons(value("cash_weight", [], envFor(en)))).toBe("The portfolio has no value yet");
  });
});
