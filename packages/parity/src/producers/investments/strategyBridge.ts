/// <reference types="node" />
/**
 * TRANSITIONAL(S14): reader of the strategy bridge (`strategy_bridge.py`), the strategy values the
 * portfolio pipeline takes from a profile until the TS strategy loader lands (S14): base currency,
 * data-quality thresholds, allocation plan, for performance the strategy state and benchmark, and for
 * the budget month close the contributions plan.
 * Delete with the bridge script.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { D, type Decimal, investments as inv } from "@cashu/domain";
import { bridgeStrategyRoot, type Dataset } from "../../sources/index.ts";

interface BridgeMatch {
  readonly asset_classes: readonly string[];
  readonly tags: readonly string[];
  readonly mics: readonly string[];
  readonly currencies: readonly string[];
  readonly pinned_instruments: readonly string[];
}

interface BridgeProfile {
  readonly data: { readonly max_price_age_days: number; readonly max_fx_age_days: number };
  readonly state: StrategyStateName;
  readonly benchmark: { readonly name: string; readonly proxy: string } | null;
  readonly contributions: {
    readonly monthly_amount: string;
    readonly day_of_month: number | null;
  } | null;
  readonly strategy: {
    readonly base_currency: string;
    readonly buckets: readonly { readonly bucket: string; readonly match: BridgeMatch }[];
    readonly targets: readonly (readonly [string, number])[];
  } | null;
}

type BridgeFile = Readonly<Record<string, BridgeProfile>>;

/** `service/strategy.State`. */
type StrategyStateName = "missing" | "valid" | "partial" | "invalid";

/** What `service/portfolio.build` (and `performance/service.load`) read from the profile's strategy. */
export interface StrategyInputs {
  /** `StrategyState.state`. */
  readonly state: StrategyStateName;
  /** `config.benchmark` (`id`, `proxy`), null without a usable strategy or benchmark section. */
  readonly benchmark: { readonly id: string; readonly proxy: string } | null;
  /** `DataQualityPolicy.max_price_age_days` (the strategy's or the default). */
  readonly maxPriceAgeDays: number;
  readonly maxFxAgeDays: number;
  /** `config.contributions` (the valid or partial config), null without one. */
  readonly contributions: {
    readonly monthlyAmount: Decimal;
    readonly dayOfMonth: number | null;
  } | null;
  /** null without a valid strategy (`strategy is None`). */
  readonly strategy: {
    readonly baseCurrency: inv.Currency;
    readonly allocation: inv.AllocationPlan;
  } | null;
}

export type StrategyBridge = ReadonlyMap<string, StrategyInputs>;

const CHECK = "investments.strategy";

/** The dir `strategy_bridge.py --out <root>` writes (its `index.json` records the source commit). */
export function strategyBridgeDir(dataset: Dataset, root: string = bridgeStrategyRoot()): string {
  return join(root, dataset);
}

export function readStrategyBridge(dataset: Dataset, root?: string): StrategyBridge {
  const path = join(strategyBridgeDir(dataset, root), `${CHECK}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `no strategy bridge output for ${dataset}: run .venv/bin/python packages/parity/src/producers/investments/strategy_bridge.py --dataset ${dataset}`,
    );
  }
  const file = JSON.parse(readFileSync(path, "utf8")) as BridgeFile;
  const out = new Map<string, StrategyInputs>();
  for (const [profileKey, p] of Object.entries(file)) {
    out.set(profileKey, {
      state: p.state,
      benchmark: p.benchmark === null ? null : { id: p.benchmark.name, proxy: p.benchmark.proxy },
      maxPriceAgeDays: p.data.max_price_age_days,
      maxFxAgeDays: p.data.max_fx_age_days,
      contributions:
        p.contributions === null
          ? null
          : {
              monthlyAmount: D(p.contributions.monthly_amount),
              dayOfMonth: p.contributions.day_of_month,
            },
      strategy:
        p.strategy === null
          ? null
          : {
              baseCurrency: inv.toCurrency(p.strategy.base_currency),
              allocation: inv.allocationPlan({
                buckets: p.strategy.buckets.map((b) =>
                  inv.bucketDef({
                    id: b.bucket,
                    match: inv.bucketMatch({
                      assetClasses: b.match.asset_classes.map(inv.parseAssetClass),
                      tags: b.match.tags,
                      mics: b.match.mics,
                      currencies: b.match.currencies.map(inv.toCurrency),
                      instrumentIds: b.match.pinned_instruments.map(inv.asInstrumentId),
                    }),
                  }),
                ),
                targets: new Map(p.strategy.targets),
              }),
            },
    });
  }
  return out;
}
