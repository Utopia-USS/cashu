/**
 * Allocation bucket contract (`investments/domain/buckets.py`) shared by the strategy loader (builds it
 * from `strategy.yaml`) and the portfolio math (`allocate` matches holdings against it). Plain data.
 */

import type { AssetClass } from "./enums.js";
import type { Currency, InstrumentId } from "./values.js";

/**
 * Bucket ids the app may show as a generic, asset-class style allocation (F7 owner decision): the
 * template ids plus plain asset-class ids. Any other id is the owner's own bucket (`core`, `active`,
 * ...): knowledge for the agent, never shown in the app. Case-sensitive, as written.
 */
export const GENERIC_BUCKET_IDS: ReadonlySet<string> = new Set([
  // every bucket id of the shipped strategy templates (templates/strategy/*.yaml)
  "global_equity",
  "bond_etfs",
  "treasury_bonds",
  "cash",
  "stocks",
  "bonds",
  // plain asset-class ids
  "equity",
  "equities",
  "fixed_income",
  "crypto",
  "real_estate",
  "reits",
  "commodities",
  "gold",
]);

/** True when `bucketId` is one of `GENERIC_BUCKET_IDS` (exact, case-sensitive match). */
export function isGenericBucket(bucketId: unknown): boolean {
  return typeof bucketId === "string" && GENERIC_BUCKET_IDS.has(bucketId);
}

/**
 * Matching criteria of one bucket (`buckets[].match` in `strategy.yaml`).
 *
 * Every non-empty criterion must hold (AND). Within a criterion any element matches (OR), except
 * `tags`, where the instrument must carry all of them. An empty criterion matches anything. MICs and
 * tags compare case-insensitively.
 */
export interface BucketMatch {
  readonly assetClasses: ReadonlySet<AssetClass>;
  /** All of these tags must be present on the instrument. */
  readonly tags: ReadonlySet<string>;
  readonly mics: ReadonlySet<string>;
  readonly currencies: ReadonlySet<Currency>;
  /** Explicit instrument pins, for one-off classification. */
  readonly instrumentIds: ReadonlySet<InstrumentId>;
}

export interface BucketMatchInit {
  readonly assetClasses?: Iterable<AssetClass>;
  readonly tags?: Iterable<string>;
  readonly mics?: Iterable<string>;
  readonly currencies?: Iterable<Currency>;
  readonly instrumentIds?: Iterable<InstrumentId>;
}

/** `BucketMatch(...)`: any iterable becomes a set, a missing criterion an empty one. */
export function bucketMatch(init: BucketMatchInit = {}): BucketMatch {
  return Object.freeze({
    assetClasses: new Set(init.assetClasses ?? []),
    tags: new Set(init.tags ?? []),
    mics: new Set(init.mics ?? []),
    currencies: new Set(init.currencies ?? []),
    instrumentIds: new Set(init.instrumentIds ?? []),
  });
}

/** `BucketMatch.is_empty`: no criterion is set (matches every instrument). */
export function bucketMatchIsEmpty(match: BucketMatch): boolean {
  return (
    match.assetClasses.size === 0 &&
    match.tags.size === 0 &&
    match.mics.size === 0 &&
    match.currencies.size === 0 &&
    match.instrumentIds.size === 0
  );
}

/**
 * One allocation bucket. Buckets are evaluated in declaration order; the first match wins. Bucket ids
 * are unique (the strategy loader rejects a duplicate id).
 */
export interface BucketDef {
  /** Bucket id referenced by `allocation.targets` (`global_equity`). */
  readonly id: string;
  readonly match: BucketMatch;
}

export function bucketDef(init: { readonly id: string; readonly match?: BucketMatch }): BucketDef {
  return Object.freeze({ id: init.id, match: init.match ?? bucketMatch() });
}

/** Buckets in declaration order plus target weights by bucket id (floats 0..1, summing to 1). */
export interface AllocationPlan {
  readonly buckets: readonly BucketDef[];
  readonly targets: ReadonlyMap<string, number>;
}

export function allocationPlan(
  init: {
    readonly buckets?: Iterable<BucketDef>;
    readonly targets?: ReadonlyMap<string, number> | Readonly<Record<string, number>>;
  } = {},
): AllocationPlan {
  const targets =
    init.targets instanceof Map
      ? new Map(init.targets)
      : new Map(Object.entries((init.targets ?? {}) as Readonly<Record<string, number>>));
  return Object.freeze({ buckets: Object.freeze([...(init.buckets ?? [])]), targets });
}
