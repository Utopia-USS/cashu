/**
 * The pure parts of `performance/backfill.py`: what one profile needs fetched (`planBackfill`, the
 * read phase of `_read` over loaded values), the source probe that settles a Yahoo-symbol proxy's
 * quote currency (`probeProxy`) and the report types. The orchestration (store reads, registering a
 * proxy, the price cache writes, the refresher) is the store's leader service.
 *
 * Every instrument a profile ever held (held now or sold) and the strategy's benchmark proxy are
 * fetched from the first date each is needed; later runs only ask for what is new.
 */

import { addDays } from "../../dates.js";
import { pyStrip, pyUpper } from "../../text.js";
import { AssetClass, TxnType } from "../domain/enums.js";
import {
  AliasNamespace,
  fetchesMarketData,
  type Instrument,
  type InstrumentRename,
  instrument,
  instrumentAlias,
} from "../domain/instrument.js";
import type { Transaction } from "../domain/transaction.js";
import {
  asInstrumentId,
  asProfileId,
  type CalendarDate,
  type Currency,
  type InstrumentId,
} from "../domain/values.js";
import {
  type PriceSource,
  QuoteCurrencyMismatchException,
  SourceException,
} from "../market/sources.js";
import { buildSnapshot } from "../portfolio/snapshotBuilder.js";

/** History is fetched from this many days before the first transaction (a price on/before it). */
export const HEAD_MARGIN_DAYS = 7;
/** A stored history starting at most this many days after `needFrom` counts as complete. */
export const HEAD_TOLERANCE_DAYS = 7;
/** Days the source is asked for when a proxy symbol is probed. */
export const PROBE_DAYS = 14;

export type BackfillRole = "held" | "sold" | "benchmark";

/** `InstrumentResult`. */
export interface InstrumentBackfill {
  readonly instrumentId: InstrumentId;
  readonly label: string;
  readonly role: BackfillRole;
  /** The first date fetched (first needed date minus `HEAD_MARGIN_DAYS`). */
  readonly needFrom: CalendarDate;
  /** `ok` (fetched or already complete), `skipped` (delisted / frozen), `no_data`, `error`. */
  status: "ok" | "skipped" | "no_data" | "error";
  head: readonly [CalendarDate, CalendarDate] | null;
  barsWritten: number;
  barsReplaced: number;
  readonly messages: string[];
}

/** `BenchmarkResult`. */
export interface BenchmarkBackfill {
  readonly profile: string;
  readonly proxy: string;
  readonly status: "found" | "added" | "not_found" | "error";
  readonly instrumentId: InstrumentId | null;
  readonly message: string | null;
}

/** One currency of the FX refresh (`FxFetch` as the report lists it). */
export interface FxBackfill {
  readonly currency: Currency;
  readonly status: string;
  readonly start: CalendarDate | null;
  readonly rates: number; // float-ok: a count of rates (Python int)
  readonly message: string | null;
}

/** `BackfillReport`. */
export interface BackfillReport {
  readonly asOf: CalendarDate;
  readonly profiles: string[];
  readonly instruments: InstrumentBackfill[];
  readonly benchmarks: BenchmarkBackfill[];
  fx: FxBackfill[];
  ratesWritten: number; // float-ok: a count (Python int)
}

export function backfillReport(asOf: CalendarDate): BackfillReport {
  return { asOf, profiles: [], instruments: [], benchmarks: [], fx: [], ratesWritten: 0 };
}

/** `_Plan`: what the read phase found. */
export interface BackfillPlan {
  readonly instruments: Map<InstrumentId, Instrument>;
  readonly needFrom: Map<InstrumentId, CalendarDate>;
  readonly roles: Map<InstrumentId, BackfillRole>;
  readonly splitDates: Map<InstrumentId, CalendarDate>;
  readonly currencies: Map<Currency, CalendarDate>;
  /** The profile's first transaction date (null without history). */
  readonly first: CalendarDate | null;
}

function earliest<K>(target: Map<K, CalendarDate>, key: K, value: CalendarDate): void {
  const current = target.get(key);
  if (current === undefined || value < current) target.set(key, value);
}

export interface PlanInput {
  /** The profile's transactions (any date; those after `asOf` are ignored). */
  readonly txns: readonly Transaction[];
  readonly renames: readonly InstrumentRename[];
  /** Loads the profile's own view of the given instruments (overrides applied). */
  readonly load: (ids: readonly InstrumentId[]) => ReadonlyMap<InstrumentId, Instrument>;
  readonly base: Currency;
  readonly asOf: CalendarDate;
}

/**
 * `_read` for one profile without the proxy: every instrument it ever held (role `held` when held on
 * `asOf`, else `sold`) from its first trade (a rename's new instrument from the rename date), the
 * newest split per instrument, and the first date each currency is needed (the base and every
 * transaction currency from the first transaction).
 */
export function planBackfill(input: PlanInput): BackfillPlan {
  const plan: BackfillPlan = {
    instruments: new Map(),
    needFrom: new Map(),
    roles: new Map(),
    splitDates: new Map(),
    currencies: new Map(),
    first: null,
  };
  const txns = input.txns.filter((t) => t.tradeDate <= input.asOf);
  if (txns.length === 0) return plan;
  let first = (txns[0] as Transaction).tradeDate;
  for (const t of txns) if (t.tradeDate < first) first = t.tradeDate;
  const snapshot = buildSnapshot(asProfileId("0"), txns, input.asOf, { renames: input.renames });
  const held = new Set(snapshot.holdings.map((h) => h.instrumentId));
  const needed = new Map<InstrumentId, CalendarDate>();
  for (const t of txns) {
    if (t.instrumentId !== null) earliest(needed, t.instrumentId, t.tradeDate);
    if (t.type === TxnType.SPLIT && t.instrumentId !== null) {
      const current = plan.splitDates.get(t.instrumentId);
      if (current === undefined || t.tradeDate > current) {
        plan.splitDates.set(t.instrumentId, t.tradeDate);
      }
    }
    earliest(plan.currencies, t.currency, first);
    earliest(plan.currencies, t.cashCurrency, first);
  }
  for (const r of input.renames) {
    if (r.date <= input.asOf) earliest(needed, r.newInstrumentId, r.date);
  }
  const loaded = input.load([...needed.keys()]);
  for (const [iid, inst] of loaded) {
    const known = plan.instruments.get(iid);
    if (known === undefined || (fetchesMarketData(inst) && !fetchesMarketData(known))) {
      plan.instruments.set(iid, inst);
    }
    const from = needed.get(iid) as CalendarDate;
    earliest(plan.needFrom, iid, from);
    earliest(plan.currencies, inst.currency, from);
    if (plan.roles.get(iid) !== "held") plan.roles.set(iid, held.has(iid) ? "held" : "sold");
  }
  earliest(plan.currencies, input.base, first);
  return { ...plan, first };
}

/** Add the benchmark proxy to the plan (needed from the first transaction). */
export function planBenchmark(plan: BackfillPlan, proxy: Instrument, first: CalendarDate): void {
  if (!plan.instruments.has(proxy.id)) plan.instruments.set(proxy.id, proxy);
  earliest(plan.needFrom, proxy.id, first);
  if (!plan.roles.has(proxy.id)) plan.roles.set(proxy.id, "benchmark");
  earliest(plan.currencies, proxy.currency, first);
}

/** `_mismatch`: the quote-currency mismatch in an error's cause chain (at most 5 deep). */
export function mismatchOf(error: unknown): QuoteCurrencyMismatchException | null {
  let current: unknown = error;
  for (let seen = 0; current !== null && current !== undefined && seen < 5; seen++) {
    if (current instanceof QuoteCurrencyMismatchException) return current;
    current = current instanceof Error ? current.cause : undefined;
  }
  return null;
}

/** The planned instrument (or the error message) of a probe. */
export type ProbeResult =
  | { readonly ok: true; readonly instrument: Instrument }
  | { readonly ok: false; readonly message: string };

/**
 * `_probe_proxy`: a planned instrument for a Yahoo-symbol proxy whose quote currency the source
 * confirmed (a mismatch answer settles the currency, then the probe is asked once more).
 */
export async function probeProxy(
  prices: PriceSource,
  proxy: string,
  guess: Currency,
  asOf: CalendarDate,
): Promise<ProbeResult> {
  const symbol = pyStrip(proxy);
  let planned = instrument({
    id: asInstrumentId("0"),
    name: symbol,
    currency: guess,
    assetClass: AssetClass.ETF,
    symbol: pyUpper(symbol.split(".")[0] ?? ""),
    aliases: [instrumentAlias(AliasNamespace.YAHOO, symbol)],
  });
  const start = addDays(asOf, -PROBE_DAYS);
  for (let attempt = 0; attempt < 2; attempt++) {
    let answer: Awaited<ReturnType<PriceSource["fetch"]>>;
    try {
      answer = await prices.fetch(planned, start, asOf);
    } catch (error) {
      if (!(error instanceof SourceException)) throw error;
      const mismatch = mismatchOf(error);
      if (mismatch !== null && mismatch.quoteCurrency !== planned.currency) {
        planned = instrument({ ...planned, currency: mismatch.quoteCurrency });
        continue;
      }
      return { ok: false, message: `${error.sourceId}: ${error.detail}` };
    }
    if (answer.bars.length === 0) {
      return { ok: false, message: `no prices for ${symbol} in the last ${PROBE_DAYS} days` };
    }
    if (answer.currency !== null && answer.currency !== planned.currency) {
      planned = instrument({ ...planned, currency: answer.currency });
    }
    return { ok: true, instrument: planned };
  }
  return { ok: false, message: `could not settle the quote currency of ${symbol}` };
}
