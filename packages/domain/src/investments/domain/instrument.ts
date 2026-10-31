/**
 * Instruments and their reference data: aliases, manual valuations, renames
 * (`investments/domain/instrument.py`).
 */

import type { DateTime } from "../../dates.js";
import type { Decimal } from "../../decimal.js";
import { AssetClass, defaultValuationMode, InstrumentStatus, type ValuationMode } from "./enums.js";
import {
  type CalendarDate,
  type Currency,
  type Init,
  type InstrumentId,
  withDefaults,
} from "./values.js";

/**
 * Well-known `InstrumentAlias.namespace` values. Broker symbols use the broker id (`xtb`,
 * `generic_csv`) as their namespace.
 */
export const AliasNamespace = Object.freeze({
  ISIN: "isin",
  STOOQ: "stooq",
  YAHOO: "yahoo",
} as const);

/**
 * An external identifier of an instrument, unique per namespace across all instruments
 * (`isin:IE00B4L5Y983`, `stooq:pkn`, `yahoo:PKN.WA`, `xtb:PKN.PL`).
 */
export interface InstrumentAlias {
  readonly namespace: string;
  readonly value: string;
  /** True when inferred (e.g. a yahoo symbol guessed from an exchange hint), not read or confirmed. */
  readonly guessed: boolean;
}

export function instrumentAlias(
  namespace: string,
  value: string,
  guessed = false,
): InstrumentAlias {
  return Object.freeze({ namespace, value, guessed });
}

/** Python `str(InstrumentAlias)`: `namespace:value`, plus ` (guessed)` for a guess. */
export function aliasToString(alias: InstrumentAlias): string {
  return `${alias.namespace}:${alias.value}${alias.guessed ? " (guessed)" : ""}`;
}

/**
 * Shared market reference data: a security, fund, bond, claim or cash-like instrument.
 *
 * The profile-view fields (`plan`, `planAt`, `planReason`, `segment`, `segmentBy`) are not part of the
 * instrument's value (Python `compare=False`): `sameInstrument` ignores them.
 */
export interface Instrument {
  readonly id: InstrumentId;
  readonly name: string;
  /** Trading / pricing currency. Price sources reject quotes in another currency. */
  readonly currency: Currency;
  readonly assetClass: AssetClass;
  /** Display ticker (`PKN`, `VWCE`), not unique. */
  readonly symbol: string | null;
  readonly isin: string | null;
  /** ISO 10383 market identifier of the main listing (`XWAR`, `XETR`). */
  readonly mic: string | null;
  readonly region: string | null;
  readonly sector: string | null;
  /** Free-form classification tags used by strategy buckets (`global_equity`). */
  readonly tags: readonly string[];
  /** True for instruments created during import that the owner has not reviewed yet. */
  readonly needsClassification: boolean;
  readonly aliases: readonly InstrumentAlias[];
  /** Never null after `instrument()`: defaults to `defaultValuationMode(assetClass)`. */
  readonly valuationMode: ValuationMode;
  readonly status: InstrumentStatus;
  /** The model recommendation (`PLAN_VALUES`) in a profile's view; null in the shared view. */
  readonly plan: string | null;
  /** When the plan was written (UTC). */
  readonly planAt: DateTime | null;
  /** The model's short reason for the recommendation (written and cleared with `plan`). */
  readonly planReason: string | null;
  /** The market segment set in a profile's view (`research.segments` key); null = not set. */
  readonly segment: string | null;
  /** Who set `segment`: `owner` (the app) or `agent` (MCP). */
  readonly segmentBy: string | null;
}

type InstrumentDefaults =
  | "symbol"
  | "isin"
  | "mic"
  | "region"
  | "sector"
  | "tags"
  | "needsClassification"
  | "aliases"
  | "valuationMode"
  | "status"
  | "plan"
  | "planAt"
  | "planReason"
  | "segment"
  | "segmentBy";

export type InstrumentInit = Omit<Init<Instrument, InstrumentDefaults>, "tags" | "aliases"> & {
  readonly tags?: Iterable<string>;
  readonly aliases?: Iterable<InstrumentAlias>;
  readonly valuationMode?: ValuationMode | null;
};

/** `Instrument(...)`: Python defaults, `valuationMode` from the asset class when not given. */
export function instrument(init: InstrumentInit): Instrument {
  const { tags, aliases, valuationMode, ...rest } = init;
  return withDefaults<Instrument>(
    {
      symbol: null,
      isin: null,
      mic: null,
      region: null,
      sector: null,
      needsClassification: false,
      status: InstrumentStatus.ACTIVE,
      plan: null,
      planAt: null,
      planReason: null,
      segment: null,
      segmentBy: null,
    },
    {
      ...rest,
      tags: Object.freeze([...(tags ?? [])]),
      aliases: Object.freeze([...(aliases ?? [])]),
      valuationMode: valuationMode ?? defaultValuationMode(init.assetClass),
    },
  );
}

/** `Instrument.alias(namespace)`: value of the alias in `namespace`; a confirmed alias wins over a guess. */
export function aliasOf(instrument: Instrument, namespace: string): string | null {
  let guess: string | null = null;
  for (const alias of instrument.aliases) {
    if (alias.namespace !== namespace) continue;
    if (!alias.guessed) return alias.value;
    if (guess === null) guess = alias.value;
  }
  return guess;
}

/** `Instrument.label`: symbol, else name (for messages). */
export function instrumentLabel(instrument: Instrument): string {
  return instrument.symbol || instrument.name;
}

/** `Instrument.fetches_market_data`: false for delisted and frozen instruments. */
export function fetchesMarketData(instrument: Instrument): boolean {
  return instrument.status === InstrumentStatus.ACTIVE;
}

/** Python `Instrument.__eq__`: every field except the profile-view ones (plan, segment, ...). */
export function sameInstrument(a: Instrument, b: Instrument): boolean {
  const sameList = <T>(x: readonly T[], y: readonly T[], eq: (p: T, q: T) => boolean) =>
    x.length === y.length && x.every((item, i) => eq(item, y[i] as T));
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.currency === b.currency &&
    a.assetClass === b.assetClass &&
    a.symbol === b.symbol &&
    a.isin === b.isin &&
    a.mic === b.mic &&
    a.region === b.region &&
    a.sector === b.sector &&
    sameList(a.tags, b.tags, (p, q) => p === q) &&
    a.needsClassification === b.needsClassification &&
    sameList(
      a.aliases,
      b.aliases,
      (p, q) => p.namespace === q.namespace && p.value === q.value && p.guessed === q.guessed,
    ) &&
    a.valuationMode === b.valuationMode &&
    a.status === b.status
  );
}

/**
 * A value per unit of an instrument set by the owner as of a date (0 is valid, e.g. a frozen ADR).
 * Used for `ValuationMode.MANUAL` and frozen instruments: the newest valuation on/before the valuation
 * date applies.
 */
export interface ManualValuation {
  readonly instrumentId: InstrumentId;
  readonly asOf: CalendarDate;
  readonly unitValue: Decimal;
  readonly currency: Currency;
  readonly note: string | null;
}

export function manualValuation(init: Init<ManualValuation, "note">): ManualValuation {
  return withDefaults<ManualValuation>({ note: null }, init);
}

/**
 * The instrument `oldInstrumentId` continues as `newInstrumentId` from `date` (ticker change, merger
 * into a successor). Open lots carry over with their cost and open date; this is not a sell plus a
 * buy. Transactions dated on/after `date` that still name the old instrument count for the new one.
 */
export interface InstrumentRename {
  readonly date: CalendarDate;
  readonly oldInstrumentId: InstrumentId;
  readonly newInstrumentId: InstrumentId;
  readonly note: string | null;
}

export function instrumentRename(init: Init<InstrumentRename, "note">): InstrumentRename {
  return withDefaults<InstrumentRename>({ note: null }, init);
}

/** Stand-in for a held instrument without metadata (asset class `other`, needs classification). */
export function placeholderInstrument(instrumentId: InstrumentId, currency: Currency): Instrument {
  return instrument({
    id: instrumentId,
    name: instrumentId,
    currency,
    assetClass: AssetClass.OTHER,
    needsClassification: true,
  });
}
