/**
 * Maps valued holdings and cash to strategy buckets and measures drift against the targets
 * (`allocation.py`). Pure.
 */

import { Decimal, floatRepr, ZERO } from "../../decimal.js";
import { pyLower, pyUpper } from "../../text.js";
import type { AllocationPlan, BucketDef, BucketMatch } from "../domain/buckets.js";
import { AssetClass } from "../domain/enums.js";
import type { Instrument } from "../domain/instrument.js";
import {
  type AllocationResult,
  allocationResult,
  type BucketAllocation,
  bucketAllocation,
  countedBase,
  type ValuedHolding,
  type ValuedPortfolio,
} from "../domain/snapshot.js";
import { type AccountId, type Currency, exact, ratio } from "../domain/values.js";

/**
 * Whether `instrument` satisfies `match`: every non-empty criterion must hold; within a criterion any
 * element matches, except tags, which must all be present. MICs and tags compare case-insensitively.
 * An empty match accepts every instrument.
 */
export function matchesBucket(match: BucketMatch, instrument: Instrument): boolean {
  if (match.assetClasses.size > 0 && !match.assetClasses.has(instrument.assetClass)) return false;
  if (match.instrumentIds.size > 0 && !match.instrumentIds.has(instrument.id)) return false;
  if (match.currencies.size > 0 && !match.currencies.has(instrument.currency)) return false;
  if (match.mics.size > 0) {
    const mic = instrument.mic ? pyUpper(instrument.mic) : null;
    if (mic === null || [...match.mics].every((m) => pyUpper(m) !== mic)) return false;
  }
  if (match.tags.size > 0) {
    const tags = new Set(instrument.tags.map(pyLower));
    if ([...match.tags].some((tag) => !tags.has(pyLower(tag)))) return false;
  }
  return true;
}

/**
 * Whether raw cash in `currency` matches `match`: cash is an instrument of asset class `cash` in
 * `currency` without tags, MIC or id, so a bucket listing `cash` (and, if it lists currencies,
 * `currency`) takes it, and so does a catch-all; buckets with tags, MICs or ids never do.
 */
export function matchesCashBucket(match: BucketMatch, currency: Currency): boolean {
  return (
    (match.assetClasses.size === 0 || match.assetClasses.has(AssetClass.CASH)) &&
    match.tags.size === 0 &&
    match.mics.size === 0 &&
    match.instrumentIds.size === 0 &&
    (match.currencies.size === 0 || match.currencies.has(currency))
  );
}

function firstMatch(buckets: readonly BucketDef[], instrument: Instrument): BucketDef | null {
  return buckets.find((b) => matchesBucket(b.match, instrument)) ?? null;
}

export interface AllocateOptions {
  /** Only holdings and cash of these accounts count (weights relative to their total). */
  readonly accountIds?: ReadonlySet<AccountId> | null;
}

/**
 * Allocates `portfolio` to the buckets of `plan`: each holding to the first bucket it matches (else
 * unclassified), each cash balance to the first bucket matching cash in its currency (else
 * unallocated). Weights = values / total (valued holdings + counted cash; negative cash counts as 0
 * and flags `cashHistoryGap`; cash without a usable rate is left out). Buckets without a target get
 * target 0; targets without a bucket get a zero allocation; a bucket id declared twice is one bucket.
 */
export const allocate = exact(
  (
    portfolio: ValuedPortfolio,
    plan: AllocationPlan,
    options: AllocateOptions = {},
  ): AllocationResult => {
    const accountIds = options.accountIds ?? null;
    const holdings = portfolio.valued.filter(
      (v) => accountIds === null || accountIds.has(v.holding.accountId),
    );
    const cash: [Currency, Decimal, boolean][] = [];
    for (const c of portfolio.cash) {
      if ((accountIds === null || accountIds.has(c.cash.accountId)) && c.amountBase !== null) {
        cash.push([c.cash.currency, countedBase(c), c.amountBase.lt(ZERO)]);
      }
    }

    const bucketIds: string[] = [];
    const values = new Map<string, Decimal>();
    for (const bucket of plan.buckets) {
      if (!values.has(bucket.id)) {
        bucketIds.push(bucket.id);
        values.set(bucket.id, ZERO);
      }
    }

    const holdingsByBucket = new Map<string, ValuedHolding[]>();
    const unclassified: ValuedHolding[] = [];
    let unclassifiedValue = ZERO;
    let total = ZERO;
    for (const h of holdings) {
      const value = h.marketValueBase ?? ZERO;
      total = total.add(value);
      const bucket = firstMatch(plan.buckets, h.instrument);
      if (bucket === null) {
        unclassified.push(h);
        unclassifiedValue = unclassifiedValue.add(value);
        continue;
      }
      values.set(bucket.id, (values.get(bucket.id) as Decimal).add(value));
      const list = holdingsByBucket.get(bucket.id);
      if (list === undefined) holdingsByBucket.set(bucket.id, [h]);
      else list.push(h);
    }

    let unallocatedCash = ZERO;
    const cashGapBuckets = new Set<string>();
    for (const [currency, amount, negative] of cash) {
      total = total.add(amount);
      const bucket = plan.buckets.find((b) => matchesCashBucket(b.match, currency)) ?? null;
      if (bucket === null) {
        unallocatedCash = unallocatedCash.add(amount);
      } else {
        values.set(bucket.id, (values.get(bucket.id) as Decimal).add(amount));
        if (negative) cashGapBuckets.add(bucket.id);
      }
    }

    for (const targetId of plan.targets.keys()) {
      if (!values.has(targetId)) {
        bucketIds.push(targetId);
        values.set(targetId, ZERO);
      }
    }

    return allocationResult({
      totalBase: total,
      unclassifiedValueBase: unclassifiedValue,
      unallocatedCashBase: unallocatedCash,
      allocations: Object.freeze(
        bucketIds.map((id) =>
          bucketAllocationOf(
            id,
            values.get(id) as Decimal,
            plan.targets.get(id) ?? 0,
            total,
            cashGapBuckets.has(id),
          ),
        ),
      ),
      holdingsByBucket: new Map(
        [...holdingsByBucket].map(([id, list]) => [id, Object.freeze(list)] as const),
      ),
      unclassified: Object.freeze(unclassified),
    });
  },
);

function bucketAllocationOf(
  bucketId: string,
  value: Decimal,
  target: number,
  total: Decimal,
  cashHistoryGap: boolean,
): BucketAllocation {
  const weight = ratio(value, total) || 0;
  const drift = weight - target;
  let driftRel: number;
  if (target !== 0) driftRel = drift / target;
  else driftRel = weight > 0 ? Number.POSITIVE_INFINITY : 0;
  return bucketAllocation({
    bucketId,
    weight,
    target,
    driftPp: drift * 100,
    driftRel,
    valueBase: value,
    // Python `Decimal(str(target))`: the float's repr, read exactly.
    driftValueBase: value.sub(Decimal.parse(floatRepr(target)).mul(total)),
    cashHistoryGap,
  });
}
