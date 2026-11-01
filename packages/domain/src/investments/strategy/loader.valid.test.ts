// Port of tests/investments/strategy/test_strategy_loader.py, class TestValidStrategies: a valid
// strategy.yaml parses into a typed config; a minimal one uses the defaults.

import { describe, expect, it } from "vitest";
import { Decimal } from "../../decimal.js";
import { allocationPlan, bucketMatch } from "../domain/buckets.js";
import { AssetClass, SignalSeverity } from "../domain/enums.js";
import { Currencies } from "../domain/values.js";
import {
  type AllocationDriftParams,
  type ContributionGapParams,
  type CustomParams,
  DEFAULT_DATA_QUALITY,
  DEFAULT_GRACE_DAYS,
  DEFAULT_PERIOD_DAYS,
  type DrawdownFromHighParams,
  EMPTY_INSTRUMENT_FILTER,
  expr,
  type PositionConcentrationParams,
  type TaggedWeightParams,
  type UnrealizedThresholdParams,
} from "../rules/index.js";
import { isoNumber, ruleById, Weekday } from "./index.js";
import { configOf, expectRebalance, issueAt, load, MINIMAL, paramsOf } from "./testing/load.js";

const FULL = `version: 1
base_currency: pln
horizon_years: 10

contributions:
  monthly_amount: 2000
  day_of_month: 10

data: { max_price_age_days: 4, max_stale_weight: 0.1 }

buckets:
  - id: global_equity
    match: { asset_class: etf, tags: [global_equity] }
  - id: pl_equity
    match: { asset_class: equity, mic: xwar, currency: PLN }
  - id: bonds
    match: { asset_class: [bond, treasury_bond] }
  - id: cash
    match: { asset_class: cash }

allocation:
  targets: { global_equity: 0.60, pl_equity: 0.15, bonds: 0.20, cash: 0.05 }
  rebalance: { absolute_band_pp: 4, relative_band: 0.2, min_trade_value: 500 }

rules:
  - { id: drift, kind: allocation_drift, severity: action, cooldown_days: 14 }
  - { id: drift_bonds, kind: allocation_drift, params: { absolute_band_pp: 2, buckets: [bonds] } }
  - { id: max_single_stock, kind: position_concentration, params: { max_weight: 0.10, asset_class: equity } }
  - { id: dip_review, kind: drawdown_from_high, params: { window_days: 252, threshold: 0.15 }, severity: action }
  - { id: loss_review, kind: loss_from_cost, params: { threshold: 0.25, tags: [satellite] } }
  - { id: profit_review, kind: gain_from_cost, params: { threshold: 0.50 } }
  - { id: cash_band, kind: cash_level, params: { min_weight: 0.01, max_weight: 0.2 } }
  - { id: missed_deposit, kind: contribution_gap, params: { grace_days: 10 } }
  - { id: theme_cap, kind: tagged_weight, params: { tags: [thematic], max_weight: 0.1 } }
  - id: bonds_low
    kind: custom
    params:
      when: 'bucket_drift_pp("bonds") <= -5 and cash_weight > 2%'
      message: Bonds are below target
  - id: small_dip
    kind: custom
    params: { scope: instrument, instrument_ids: [i-PKN], when: "drawdown_from_high(20) > 10%" }

watchlist:
  criteria: { max_pe: 20, min_dividend_yield: 0.03, min_market_cap_pln: 1000000000 }

benchmark: { id: msci_acwi, proxy: VWCE.DE, currency: EUR }

notifications: { immediate: [action, info], digest_weekday: Friday }
`;

describe("TestValidStrategies", () => {
  it("test_a_full_strategy_parses_into_a_typed_config", () => {
    const result = load(FULL, "# Cel\nRosnąć.");
    expect(result.issues).toEqual([]);
    const config = configOf(result);
    expect([config.version, config.baseCurrency, config.horizonYears]).toEqual([1, "PLN", 10]);
    const contributions = config.contributions;
    expect(contributions).not.toBeNull();
    if (contributions !== null) {
      expect(contributions.monthlyAmount.eq(Decimal.fromInt(2000))).toBe(true);
      expect(contributions.dayOfMonth).toBe(10);
    }
    expect(config.data).toEqual({
      ...DEFAULT_DATA_QUALITY,
      maxPriceAgeDays: 4,
      maxStaleWeight: 0.1,
    });
    expect(config.markdown).toBe("# Cel\nRosnąć.");
    expect(config.allocation.buckets.map((b) => b.id)).toEqual([
      "global_equity",
      "pl_equity",
      "bonds",
      "cash",
    ]);
    expect(config.allocation.buckets[1]?.match).toEqual(
      bucketMatch({
        assetClasses: [AssetClass.EQUITY],
        mics: ["XWAR"],
        currencies: [Currencies.PLN],
      }),
    );
    expect(config.allocation.buckets[2]?.match.assetClasses).toEqual(
      new Set([AssetClass.BOND, AssetClass.TREASURY_BOND]),
    );
    expect(Object.fromEntries(config.allocation.targets)).toEqual({
      global_equity: 0.6,
      pl_equity: 0.15,
      bonds: 0.2,
      cash: 0.05,
    });
    expectRebalance(config.rebalance, 4, 0.2, "500");
    expect(config.rules.map((r) => r.id)).toEqual([
      "drift",
      "drift_bonds",
      "max_single_stock",
      "dip_review",
      "loss_review",
      "profit_review",
      "cash_band",
      "missed_deposit",
      "theme_cap",
      "bonds_low",
      "small_dip",
    ]);
    const drift = ruleById(config, "drift");
    expect(drift).not.toBeNull();
    if (drift !== null) {
      expect([drift.severity, drift.cooldownDays]).toEqual([SignalSeverity.ACTION, 14]);
      expect(drift.kind).toBe("allocation_drift");
      // defaults from allocation.rebalance
      const bands = (drift.params as AllocationDriftParams).bands;
      expectRebalance(
        bands,
        config.rebalance.absoluteBandPp,
        config.rebalance.relativeBand,
        config.rebalance.minTradeValue.toString(),
      );
    }
    const driftBonds = paramsOf<AllocationDriftParams>(config, "drift_bonds");
    expect(driftBonds.bands.absoluteBandPp, "rule params override rebalance").toBe(2);
    expect(driftBonds.bands.relativeBand).toBe(0.2);
    expect(driftBonds.buckets).toEqual(["bonds"]);
    expect(paramsOf<PositionConcentrationParams>(config, "max_single_stock")).toEqual({
      maxWeight: 0.1,
      filter: { ...EMPTY_INSTRUMENT_FILTER, assetClasses: new Set([AssetClass.EQUITY]) },
    });
    expect(paramsOf<DrawdownFromHighParams>(config, "dip_review")).toEqual({
      threshold: 0.15,
      windowDays: 252,
      filter: EMPTY_INSTRUMENT_FILTER,
    });
    expect(paramsOf<UnrealizedThresholdParams>(config, "loss_review").filter.tags).toEqual([
      "satellite",
    ]);
    expect(paramsOf<ContributionGapParams>(config, "missed_deposit")).toEqual({
      periodDays: DEFAULT_PERIOD_DAYS,
      graceDays: DEFAULT_GRACE_DAYS,
    });
    expect(paramsOf<TaggedWeightParams>(config, "theme_cap")).toEqual({
      tags: ["thematic"],
      maxWeight: 0.1,
    });
    const bondsLow = ruleById(config, "bonds_low");
    expect(bondsLow?.kind).toBe("custom");
    const bondsLowParams = paramsOf<CustomParams>(config, "bonds_low");
    expect(bondsLowParams.expression).not.toBeNull();
    expect([bondsLowParams.scope, bondsLowParams.message]).toEqual([
      expr.Scope.PORTFOLIO,
      "Bonds are below target",
    ]);
    const smallDip = paramsOf<CustomParams>(config, "small_dip");
    expect(smallDip.scope).toBe(expr.Scope.INSTRUMENT);
    expect(smallDip.filter.instrumentIds).toEqual(new Set(["i-PKN"]));
    expect(ruleById(config, "nope")).toBeNull();
    expect(config.watchlist.values.get("max_pe")).toBe(20);
    expect(config.watchlist.values.get("min_dividend_yield")).toBe(0.03);
    expect(config.watchlist.values.get("min_market_cap_pln")).toBe(1e9);
    expect(config.benchmark).toEqual({ id: "msci_acwi", proxy: "VWCE.DE", currency: "EUR" });
    expect(config.notifications).toEqual({
      immediate: new Set([SignalSeverity.ACTION, SignalSeverity.INFO]),
      digestWeekday: Weekday.FRIDAY,
    });
    expect(isoNumber(Weekday.FRIDAY)).toBe(5);
  });

  it.todo("test_the_parsed_rules_run_in_the_engine - needs the rules engine (S15b)");

  it("test_a_minimal_strategy_uses_defaults", () => {
    const config = configOf(load(MINIMAL));
    expect(config.allocation).toEqual(allocationPlan());
    expectRebalance(config.rebalance, 5, 0.25, "0");
    expect(config.data).toEqual(DEFAULT_DATA_QUALITY);
    expect(config.contributions).toBeNull();
    expect(config.rules).toEqual([]);
    expect(config.watchlist.values.size).toBe(0);
    expect(config.horizonYears).toBeNull();
    expect(config.benchmark).toBeNull();
    expect(config.notifications).toEqual({
      immediate: new Set([SignalSeverity.ACTION]),
      digestWeekday: Weekday.SUNDAY,
    });
  });

  it("test_data_policy_keys_are_optional_read_and_validated", () => {
    const defaults = DEFAULT_DATA_QUALITY;
    expect([
      defaults.maxPriceAgeDays,
      defaults.maxStaleWeight,
      defaults.maxUnclassifiedWeight,
      defaults.maxFxAgeDays,
    ]).toEqual([5, 0.05, 0.02, 10]);
    const result = load(`${MINIMAL}data: { max_unclassified_weight: 0.1, max_fx_age_days: 7 }\n`);
    expect(result.issues).toEqual([]);
    expect(configOf(result).data).toEqual({
      ...DEFAULT_DATA_QUALITY,
      maxUnclassifiedWeight: 0.1,
      maxFxAgeDays: 7,
    });
    const bad = load(
      `${MINIMAL}data: { max_unclassified_weight: 2, max_fx_age_days: 0, max_price_age_days: 1.5 }\n`,
    );
    expect(issueAt(bad, "data.max_unclassified_weight").message).toContain(
      "(fractions: 0.15 = 15%)",
    );
    expect(issueAt(bad, "data.max_fx_age_days").message).toContain("at least 1");
    expect(issueAt(bad, "data.max_price_age_days").message).toContain("whole number, got 1.5");
  });

  it("test_max_unverified_days_defaults_to_14_and_null_means_never", () => {
    expect(DEFAULT_DATA_QUALITY.maxUnverifiedDays).toBe(14);
    expect(configOf(load(MINIMAL)).data.maxUnverifiedDays).toBe(14);
    const result = load(`${MINIMAL}data: { max_unverified_days: 30 }\n`);
    expect(result.issues).toEqual([]);
    expect(configOf(result).data.maxUnverifiedDays).toBe(30);
    const never = load(`${MINIMAL}data: { max_unverified_days: null }\n`);
    expect(never.issues).toEqual([]);
    expect(configOf(never).data.maxUnverifiedDays).toBeNull();
    const bad = load(`${MINIMAL}data: { max_unverified_days: 0 }\n`);
    expect(issueAt(bad, "data.max_unverified_days").message).toContain("at least 1");
  });

  it("test_explicit_nulls_count_as_absent_sections", () => {
    const result = load(`${MINIMAL}data:\nrules:\nwatchlist:\nbenchmark:\nnotifications:\n`);
    expect(result.issues).toEqual([]);
    expect(configOf(result).data).toEqual(DEFAULT_DATA_QUALITY);
  });

  it("test_notifications_can_disable_immediate_alerts", () => {
    const result = load(`${MINIMAL}notifications: { immediate: [] }\n`);
    expect(configOf(result).notifications.immediate).toEqual(new Set());
  });
});
