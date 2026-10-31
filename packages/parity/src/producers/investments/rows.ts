/**
 * Source rows -> investments domain values, the way the Python store converts them
 * (`store/convert.py`, `store/instruments.py:load` / `apply_override`, `store/market.py`).
 *
 * Domain ids are the app's `str(pk)` (`convert.sid`), not natural keys: the portfolio math orders
 * ties by id in Python `str` order, so the TS pipeline must see the same strings. Natural keys are
 * applied only when the result is written (`serialize.ts`).
 */

import { addDays, D, type DateTime, investments as inv, parseDateTime } from "@cashu/domain";
import type {
  InvAliasRow,
  InvFxRateRow,
  InvInstrumentRow,
  InvManualValuationRow,
  InvPriceBarRow,
  InvProfileInstrumentRow,
  InvRenameRow,
  InvTransactionRow,
  PythonDb,
} from "../../sources/index.ts";

/** `convert.sid`. */
export const sid = (pk: number): string => String(pk);

/** `convert.pk` (domain ids here are always stored row ids). */
export function pk(id: string): number {
  const n = Number(id);
  if (!Number.isSafeInteger(n)) throw new Error("not a stored row id");
  return n;
}

/** `convert.aware`: a naive stored timestamp is UTC. */
function aware(text: string): DateTime {
  const value = parseDateTime(text);
  return value.offsetSeconds === null ? { ...value, offsetSeconds: 0 } : value;
}

const decimalOrNull = (text: string | null) => (text === null ? null : D(text));

export function transaction(row: InvTransactionRow): inv.Transaction {
  return inv.transaction({
    id: inv.asTxnId(sid(row.id)),
    accountId: inv.asAccountId(sid(row.accountId)),
    type: inv.parseTxnType(row.type),
    tradeDate: row.tradeDate,
    currency: inv.toCurrency(row.currency),
    grossAmount: D(row.grossAmount),
    cashAmount: D(row.cashAmount),
    cashCurrency: inv.toCurrency(row.cashCurrency),
    instrumentId: row.instrumentId === null ? null : inv.asInstrumentId(sid(row.instrumentId)),
    settleDate: row.settleDate,
    quantity: decimalOrNull(row.quantity),
    price: decimalOrNull(row.price),
    fee: row.fee === null ? D("0") : D(row.fee),
    tax: row.tax === null ? D("0") : D(row.tax),
    fxRate: decimalOrNull(row.fxRate),
    splitRatio: decimalOrNull(row.splitRatio),
    note: row.note,
    source: inv.parseTxnSource(row.source),
    importBatchId: row.importBatchId === null ? null : inv.asImportBatchId(sid(row.importBatchId)),
    externalRef: row.externalRef,
    dedupHash: row.dedupHash,
    createdAt: aware(row.createdAt),
  });
}

export function rename(row: InvRenameRow): inv.InstrumentRename {
  return inv.instrumentRename({
    date: row.date,
    oldInstrumentId: inv.asInstrumentId(sid(row.oldInstrumentId)),
    newInstrumentId: inv.asInstrumentId(sid(row.newInstrumentId)),
    note: row.note,
  });
}

export function manualValuation(row: InvManualValuationRow): inv.ManualValuation {
  return inv.manualValuation({
    instrumentId: inv.asInstrumentId(sid(row.instrumentId)),
    asOf: row.asOf,
    unitValue: D(row.unitValue),
    currency: inv.toCurrency(row.currency),
    note: row.note,
  });
}

export function priceBar(row: InvPriceBarRow): inv.PriceBar {
  return inv.priceBar({
    instrumentId: inv.asInstrumentId(sid(row.instrumentId)),
    date: row.date,
    close: D(row.close),
    source: row.source,
    fetchedAt: row.fetchedAt === null ? null : aware(row.fetchedAt),
    open: decimalOrNull(row.open),
    high: decimalOrNull(row.high),
    low: decimalOrNull(row.low),
    volume: row.volume,
    currency: row.currency === null ? null : inv.toCurrency(row.currency),
  });
}

export function fxRate(row: InvFxRateRow): inv.FxRate {
  return inv.fxRate({
    quote: inv.toCurrency(row.quote),
    base: inv.toCurrency(row.base),
    date: row.date,
    rate: D(row.rate),
    source: row.source,
    fetchedAt: row.fetchedAt === null ? null : aware(row.fetchedAt),
  });
}

/** `convert.instrument`: aliases ordered by (namespace, guessed, id). */
function instrument(row: InvInstrumentRow, aliases: readonly InvAliasRow[]): inv.Instrument {
  const ordered = [...aliases].sort((a, b) => {
    if (a.namespace !== b.namespace) return inv.comparePyStr(a.namespace, b.namespace);
    if (a.guessed !== b.guessed) return a.guessed ? 1 : -1;
    return a.id - b.id;
  });
  return inv.instrument({
    id: inv.asInstrumentId(sid(row.id)),
    name: row.name,
    currency: inv.toCurrency(row.currency),
    assetClass: inv.parseAssetClass(row.assetClass),
    symbol: row.symbol,
    isin: row.isin,
    mic: row.mic,
    region: row.region,
    sector: row.sector,
    tags: row.tags,
    needsClassification: row.needsClassification,
    aliases: ordered.map((a) => inv.instrumentAlias(a.namespace, a.value, a.guessed)),
    valuationMode: inv.parseValuationMode(row.valuationMode),
    status: inv.parseInstrumentStatus(row.status),
  });
}

/**
 * `instruments.apply_override`: the profile's overrides (null = keep, "" = clear a text attribute)
 * and the model recommendation; `dataclasses.replace` re-runs the factory.
 */
function applyOverride(base: inv.Instrument, o: InvProfileInstrumentRow): inv.Instrument {
  const changes: Partial<Record<keyof inv.Instrument, unknown>> = {};
  if (o.name) changes.name = o.name;
  if (o.assetClass) changes.assetClass = inv.parseAssetClass(o.assetClass);
  if (o.tags !== null) changes.tags = o.tags;
  if (o.region !== null) changes.region = o.region || null;
  if (o.sector !== null) changes.sector = o.sector || null;
  if (o.valuationMode) changes.valuationMode = inv.parseValuationMode(o.valuationMode);
  if (o.status) changes.status = inv.parseInstrumentStatus(o.status);
  if (o.needsClassification !== null) changes.needsClassification = o.needsClassification;
  if (o.plan !== null) {
    changes.plan = o.plan;
    changes.planAt = o.planAt === null ? null : aware(o.planAt);
    changes.planReason = o.planReason;
  }
  if (o.segment !== null) {
    changes.segment = o.segment;
    changes.segmentBy = o.segmentBy;
  }
  if (Object.keys(changes).length === 0) return base;
  return inv.instrument({ ...base, ...changes } as inv.InstrumentInit);
}

/**
 * `instruments.load(ids, profile_id=...)`: domain instruments by domain id as the profile sees them.
 * The map is in id order (Python builds it from the rows' order; only lookups use it).
 */
export function loadInstruments(
  db: PythonDb,
  profileId: number,
  ids: Iterable<number>,
): Map<inv.InstrumentId, inv.Instrument> {
  const wanted = [...new Set(ids)].sort((a, b) => a - b);
  const aliases = new Map<number, InvAliasRow[]>();
  for (const a of db.investments.aliases(wanted)) {
    const list = aliases.get(a.instrumentId) ?? [];
    list.push(a);
    aliases.set(a.instrumentId, list);
  }
  const overrides = new Map(
    db.investments.profileInstruments(profileId, wanted).map((o) => [o.instrumentId, o] as const),
  );
  const out = new Map<inv.InstrumentId, inv.Instrument>();
  for (const row of db.investments.instruments(wanted)) {
    let found = instrument(row, aliases.get(row.id) ?? []);
    const override = overrides.get(row.id);
    if (override !== undefined) found = applyOverride(found, override);
    out.set(found.id, found);
  }
  return out;
}

/** Bars of `ids` dated `since..until` (all history when `since` is null), oldest first (`market.bars`). */
export function barsBetween(
  bars: readonly inv.PriceBar[],
  ids: ReadonlySet<inv.InstrumentId>,
  until: string,
  since: string | null,
): Map<inv.InstrumentId, inv.PriceBar[]> {
  const out = new Map<inv.InstrumentId, inv.PriceBar[]>();
  // `bars` come in (instrument pk, date) order like the SQL; grouping keeps that order.
  for (const bar of bars) {
    if (!ids.has(bar.instrumentId) || bar.date > until) continue;
    if (since !== null && bar.date < since) continue;
    const list = out.get(bar.instrumentId) ?? [];
    list.push(bar);
    out.set(bar.instrumentId, list);
  }
  return out;
}

/** The FX base of stored rates (`store/market.py:FX_BASE`, NBP: PLN per 1 unit of the quote). */
const FX_BASE = inv.Currencies.PLN;

/**
 * `market.rates`: PLN rates of `currencies` dated `since..until` plus the newest one before `since`,
 * per currency in code order.
 */
export function ratesBetween(
  rates: readonly inv.FxRate[],
  currencies: Iterable<inv.Currency>,
  until: string,
  since: string | null,
): inv.FxRate[] {
  const codes = [...new Set([...currencies].map(String))]
    .filter((c) => c !== FX_BASE)
    .sort(inv.comparePyStr);
  const out: inv.FxRate[] = [];
  for (const code of codes) {
    const series = rates.filter((r) => r.base === FX_BASE && r.quote === code && r.date <= until);
    if (since !== null) {
      const before = series.filter((r) => r.date < since);
      const newest = before[before.length - 1];
      if (newest !== undefined) out.push(newest);
      out.push(...series.filter((r) => r.date >= since));
    } else {
      out.push(...series);
    }
  }
  return out;
}

/** `as_of - days` (Python `as_of - dt.timedelta(days=...)`). */
export const daysBefore = (asOf: string, days: number): string => addDays(asOf, -days);
