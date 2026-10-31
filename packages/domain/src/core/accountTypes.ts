/**
 * Account type registry: what each kind of account means for net worth (`core/account_types.py`).
 *
 * Every module registers the account types it owns (through its `ModuleSpec`) with their net-worth
 * semantics, instead of one shared enum with module-specific meaning spread over the code:
 *
 * - `sign`: `asset` (adds at face value), `liability` (stored as the outstanding amount, subtracts)
 *   or `credit` (a credit card: a positive balance is available credit and counts 0, only a negative
 *   balance is debt);
 * - `liquid`: counts toward "liquid" net worth;
 * - `bucket`: the net-worth chart bucket it stacks into (see `NetWorthBucket`);
 * - `label`: Polish display label (UI data), `labelEn` its English variant (null: the Polish one).
 *
 * Ids are the stored `accounts.type` values. Python keeps the registry in module globals; here it is
 * a value (`AccountTypeRegistry`) built by `createCoreRegistry`, so domain stays free of shared state.
 */

import { pickLabel, type UiLang } from "./i18n.js";

export type Sign = "asset" | "liability" | "credit";

export interface AccountTypeInfo {
  readonly id: string;
  /** Owner module id ("core" for the fallback of an unknown type). */
  readonly module: string;
  readonly label: string;
  readonly sign: Sign;
  readonly liquid: boolean;
  readonly bucket: string;
  readonly labelEn: string | null;
}

/** A net-worth chart bucket; the buckets of all accounts sum to the total. */
export interface NetWorthBucket {
  readonly id: string;
  /** Polish display label (UI data). */
  readonly label: string;
  /** Stacking order: assets bottom-up, then liabilities. */
  readonly order: number;
  readonly liability: boolean;
  readonly labelEn: string | null;
}

/** `AccountTypeInfo(id, module, label, sign="asset", liquid=True, bucket="money", label_en=None)`. */
export function accountType(
  id: string,
  module: string,
  label: string,
  opts: Partial<Pick<AccountTypeInfo, "sign" | "liquid" | "bucket" | "labelEn">> = {},
): AccountTypeInfo {
  return Object.freeze({
    id,
    module,
    label,
    sign: opts.sign ?? "asset",
    liquid: opts.liquid ?? true,
    bucket: opts.bucket ?? "money",
    labelEn: opts.labelEn ?? null,
  });
}

/** `NetWorthBucket(id, label, order, liability=False, label_en=None)`. */
export function netWorthBucket(
  id: string,
  label: string,
  order: number,
  opts: Partial<Pick<NetWorthBucket, "liability" | "labelEn">> = {},
): NetWorthBucket {
  return Object.freeze({
    id,
    label,
    order,
    liability: opts.liability ?? false,
    labelEn: opts.labelEn ?? null,
  });
}

/** Everything liquid that no module claims a special bucket for. */
export const MONEY_BUCKET: NetWorthBucket = netWorthBucket("money", "Pieniądze", 0, {
  labelEn: "Money",
});

/** `display_label`: the label in the given UI language. */
export function accountTypeLabel(info: AccountTypeInfo, lang: UiLang): string {
  return pickLabel(lang, info.label, info.labelEn);
}

/** `NetWorthBucket.display_label`; `label` stays Polish (MCP, CLI). */
export function bucketLabel(bucket: NetWorthBucket, lang: UiLang): string {
  return pickLabel(lang, bucket.label, bucket.labelEn);
}

function sameType(a: AccountTypeInfo, b: AccountTypeInfo): boolean {
  return (
    a.id === b.id &&
    a.module === b.module &&
    a.label === b.label &&
    a.sign === b.sign &&
    a.liquid === b.liquid &&
    a.bucket === b.bucket &&
    a.labelEn === b.labelEn
  );
}

function sameBucket(a: NetWorthBucket, b: NetWorthBucket): boolean {
  return (
    a.id === b.id &&
    a.label === b.label &&
    a.order === b.order &&
    a.liability === b.liability &&
    a.labelEn === b.labelEn
  );
}

/** A registration that clashes with an existing different entry (Python's `ValueError`). */
export class RegistryConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RegistryConflictError";
  }
}

export class AccountTypeRegistry {
  private readonly types = new Map<string, AccountTypeInfo>();
  private readonly bucketsById = new Map<string, NetWorthBucket>();

  constructor() {
    this.registerBucket(MONEY_BUCKET);
  }

  /** `register_type`: the same entry again is fine, a different one under the same id throws. */
  registerType(info: AccountTypeInfo): void {
    const current = this.types.get(info.id);
    if (current !== undefined && !sameType(current, info)) {
      throw new RegistryConflictError(
        `Account type '${info.id}' is already registered by '${current.module}'`,
      );
    }
    this.types.set(info.id, info);
  }

  /** `register_bucket`: same rule as `registerType`. */
  registerBucket(bucket: NetWorthBucket): void {
    const current = this.bucketsById.get(bucket.id);
    if (current !== undefined && !sameBucket(current, bucket)) {
      throw new RegistryConflictError(`Net-worth bucket '${bucket.id}' is already registered`);
    }
    this.bucketsById.set(bucket.id, bucket);
  }

  /** `get`: metadata of an account type; an unknown id is a liquid asset in "money". */
  get(typeId: string): AccountTypeInfo {
    return this.types.get(typeId) ?? accountType(typeId, "core", typeId);
  }

  /** `all_types`, in registration order. */
  all(): AccountTypeInfo[] {
    return [...this.types.values()];
  }

  ids(): string[] {
    return [...this.types.keys()];
  }

  /** `buckets`: sorted by stacking order (stable for equal orders, like Python's `sorted`). */
  buckets(): NetWorthBucket[] {
    return [...this.bucketsById.values()].sort((a, b) => a.order - b.order);
  }

  /** `bucket`: an unknown id gets a placeholder at the end of the stack. */
  bucket(bucketId: string): NetWorthBucket {
    return this.bucketsById.get(bucketId) ?? netWorthBucket(bucketId, bucketId, 999);
  }
}
