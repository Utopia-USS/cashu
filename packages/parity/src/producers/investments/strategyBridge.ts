/// <reference types="node" />
/**
 * TRANSITIONAL(S14): reader of the strategy bridge (`strategy_bridge.py`), the strategy values the
 * portfolio pipeline takes from a profile until the TS strategy loader lands (S14): base currency,
 * data-quality thresholds, allocation plan. Delete with the bridge script.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { investments as inv } from "@cashu/domain";
import { type Dataset, labRoot } from "../../sources/index.ts";

interface BridgeMatch {
  readonly asset_classes: readonly string[];
  readonly tags: readonly string[];
  readonly mics: readonly string[];
  readonly currencies: readonly string[];
  readonly pinned_instruments: readonly string[];
}

interface BridgeProfile {
  readonly data: { readonly max_price_age_days: number; readonly max_fx_age_days: number };
  readonly strategy: {
    readonly base_currency: string;
    readonly buckets: readonly { readonly bucket: string; readonly match: BridgeMatch }[];
    readonly targets: readonly (readonly [string, number])[];
  } | null;
}

type BridgeFile = Readonly<Record<string, BridgeProfile>>;

/** What `service/portfolio.build` reads from the profile's strategy. */
export interface StrategyInputs {
  /** `DataQualityPolicy.max_price_age_days` (the strategy's or the default). */
  readonly maxPriceAgeDays: number;
  readonly maxFxAgeDays: number;
  /** null without a valid strategy (`strategy is None`). */
  readonly strategy: {
    readonly baseCurrency: inv.Currency;
    readonly allocation: inv.AllocationPlan;
  } | null;
}

export type StrategyBridge = ReadonlyMap<string, StrategyInputs>;

const CHECK = "investments.strategy";

export function readStrategyBridge(dataset: Dataset, root: string = labRoot()): StrategyBridge {
  const path = join(root, "parity", "bridge-strategy", dataset, `${CHECK}.json`);
  if (!existsSync(path)) {
    throw new Error(
      `no strategy bridge output for ${dataset}: run .venv/bin/python packages/parity/src/producers/investments/strategy_bridge.py --dataset ${dataset}`,
    );
  }
  const file = JSON.parse(readFileSync(path, "utf8")) as BridgeFile;
  const out = new Map<string, StrategyInputs>();
  for (const [profileKey, p] of Object.entries(file)) {
    out.set(profileKey, {
      maxPriceAgeDays: p.data.max_price_age_days,
      maxFxAgeDays: p.data.max_fx_age_days,
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
