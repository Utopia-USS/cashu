/** Allocation read projection; rebalance status comes from the real allocation_drift evaluator. */
import { type Decimal, roundFloat, ZERO } from "../../decimal.js";
import {
  type InstrumentId,
  instrumentLabel,
  isGenericBucket,
  unclassifiedWeight,
} from "../domain/index.js";
import {
  AllocationDriftParams,
  allocationDriftRule,
  buildRuleContext,
  type RuleSpec,
  sortedLabels,
} from "../rules/index.js";
import { ratioPct } from "./positions.js";
import type { PortfolioProjectionInput } from "./types.js";

interface Band {
  readonly out_of_band: boolean | null;
  readonly reason: string | null;
}
function bands(input: PortfolioProjectionInput): ReadonlyMap<string, Band> {
  const { state, options } = input,
    config = state.config,
    out = new Map<string, Band>();
  if (config === null || state.allocation === null) return out;
  const ctx = buildRuleContext({
    profileId: state.vault,
    asOf: state.asOf,
    portfolio: state.valued,
    market: state.market,
    allocation: state.allocation,
    data: config.data,
    contributions: config.contributions,
    lang: options.lang,
  });
  const spec: RuleSpec<AllocationDriftParams> = {
    id: "bands",
    kind: "allocation_drift",
    params: new AllocationDriftParams({ bands: config.rebalance }),
    severity: "info",
    cooldownDays: null,
    polarity: null,
  };
  for (const outcome of allocationDriftRule.evaluate(ctx, spec)) {
    if (outcome.type === "fired") {
      const id = outcome.candidate.payload.bucket_id;
      if (typeof id !== "string") throw new Error("allocation band missing bucket identity");
      out.set(id, { out_of_band: true, reason: null });
    } else if (outcome.type === "not_fired" && outcome.dedupKey !== null) {
      const index = outcome.dedupKey.indexOf("|s:");
      out.set(index < 0 ? outcome.dedupKey : outcome.dedupKey.slice(index + 3), {
        out_of_band: false,
        reason: null,
      });
    } else if (outcome.dedupKey === null)
      return new Map([
        ["*", { out_of_band: null, reason: outcome.type === "skipped" ? outcome.reason : null }],
      ]);
    else {
      const index = outcome.dedupKey.indexOf("|s:");
      out.set(index < 0 ? outcome.dedupKey : outcome.dedupKey.slice(index + 3), {
        out_of_band: null,
        reason: outcome.type === "skipped" ? outcome.reason : null,
      });
    }
  }
  return out;
}
export function allocationView(input: PortfolioProjectionInput) {
  const { state } = input,
    total = state.valued.totalBase,
    byClass = new Map<string, Decimal>(),
    byRegion = new Map<string, Decimal>();
  for (const v of state.valued.valued) {
    if (v.marketValueBase === null) continue;
    const c = v.instrument.assetClass,
      r = v.instrument.region || "unknown";
    byClass.set(c, (byClass.get(c) ?? ZERO).add(v.marketValueBase));
    byRegion.set(r, (byRegion.get(r) ?? ZERO).add(v.marketValueBase));
  }
  if (!state.valued.cashBase.isZero())
    byClass.set("cash", (byClass.get("cash") ?? ZERO).add(state.valued.cashBase));
  const shares = (values: ReadonlyMap<string, Decimal>) =>
    [...values]
      .sort((a, b) => b[1].compare(a[1]))
      .map(([key, value]) => ({
        key,
        value,
        weight: total.isZero() ? null : ratioPct(value.div(total).toFloat()),
      }));
  const config = state.config,
    allocation = state.allocation,
    found = bands(input);
  const buckets =
    config === null || allocation === null
      ? []
      : allocation.allocations.map((b) => {
          const band = found.get("*") ??
            found.get(b.bucketId) ?? { out_of_band: null, reason: null };
          return {
            bucket_id: b.bucketId,
            generic: isGenericBucket(b.bucketId),
            weight: ratioPct(b.weight),
            target: b.target,
            drift_pp: roundFloat(b.driftPp, 4),
            value: b.valueBase,
            to_target: b.driftValueBase.neg(),
            out_of_band: band.out_of_band,
            band_note: band.reason,
            cash_history_gap: b.cashHistoryGap,
            instrument_ids: (allocation.holdingsByBucket.get(b.bucketId) ?? []).map(
              (h) => h.instrument.id,
            ),
          };
        });
  const unclassified = new Map<InstrumentId, string>();
  for (const h of allocation?.unclassified ?? [])
    unclassified.set(h.instrument.id, instrumentLabel(h.instrument));
  const labelRanks = new Map(
    sortedLabels(new Set(unclassified.values())).map((label, index) => [label, index]),
  );
  return {
    base_currency: state.base,
    total,
    has_strategy: config !== null,
    buckets,
    unclassified:
      config === null || allocation === null
        ? null
        : {
            value: allocation.unclassifiedValueBase,
            weight: ratioPct(unclassifiedWeight(allocation)),
            instruments: [...unclassified]
              .sort((a, b) => (labelRanks.get(a[1]) ?? 0) - (labelRanks.get(b[1]) ?? 0))
              .map(([id, label]) => ({ id, label })),
          },
    unallocated_cash:
      config === null || allocation === null ? null : allocation.unallocatedCashBase,
    by_asset_class: shares(byClass),
    by_region: shares(byRegion),
    band:
      config === null || allocation === null
        ? null
        : {
            absolute_band_pp: config.rebalance.absoluteBandPp,
            relative_band: config.rebalance.relativeBand,
            min_trade_value: config.rebalance.minTradeValue,
          },
    buckets_generic: buckets.length > 0 && buckets.every((b) => b.generic),
  };
}
export type AllocationView = ReturnType<typeof allocationView>;
