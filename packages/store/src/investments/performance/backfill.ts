// The price history backfill of one vault (Python `performance/backfill.py`), a leader service: every
// instrument the vault ever held (held now or sold) and the strategy's benchmark proxy, from the first
// transaction date onward, into the device's price cache; incremental afterwards. The network is the
// injected sources (`@cashu/market` on the leader); the only vault write is registering the benchmark
// proxy as an instrument (or settling its quote currency), through events.
//
// Phases (no store transaction across network IO): read the plan from the view; register a proxy a
// market symbol names; probe a proxy the cache has no bars of at the source (settles its currency);
// per instrument fetch the missing head of the history, then bring the stored tail up to date with the
// shared refresher (incremental, split re-fetch); FX with `fxHistoryFrom` = the first date each
// currency is needed. Delisted and frozen instruments are not fetched.
import { addDays, type DateTime, daysBetween, parseDateTime } from "@cashu/domain";
import {
  asInstrumentId,
  type CalendarDate,
  type Currency,
  fetchesMarketData,
  type Instrument,
  instrumentLabel,
  market,
  type PriceBar,
  performance as perf,
  toCurrency,
} from "@cashu/domain/investments";
import { z } from "zod";
import {
  type CommandEnv,
  type CommandResult,
  defineCommand,
  type EventWriter,
  ok,
  refuse,
  runCommand,
} from "../../command.js";
import { profileOf } from "../../core/queries.js";
import type { Store } from "../../materialize.js";
import { createInstrument } from "../commands/instruments.js";
import { loadInstrument, loadInstruments } from "../queries/instruments.js";
import type { Read } from "../queries/shared.js";
import { marks } from "../queries/shared.js";
import { renames, transactions } from "../queries/transactions.js";
import { findProxy } from "./inputs.js";

export interface BackfillDeps {
  readonly store: Store;
  readonly writer: EventWriter;
  readonly env: CommandEnv;
  /** The device's price cache (shared by every vault on the device). */
  readonly cache: market.PriceCache;
  readonly sources: { readonly prices: market.PriceSource; readonly fx: market.FxSource };
  readonly strategy: perf.PerformanceStrategy;
  readonly asOf: CalendarDate;
  /** The vault's label in the report (the profile slug). */
  readonly profile: string;
  readonly refresher?: market.RefresherOptions;
  readonly order?: market.PriceSourceOrder;
}

export type BackfillResult =
  | { readonly ok: true; readonly value: perf.BackfillReport }
  | { readonly ok: false; readonly reason: "not_leader" | "busy" };

/** Caches with a backfill running in this process (Python's run lock: one backfill at a time). */
const running = new WeakSet<market.PriceCache>();

/**
 * Python `is_reference_only`: nothing of the vault references the instrument (no transaction, broker
 * snapshot, watchlist item incl. removed ones, alert or override) and the cache has no bars of it: a
 * freshly registered reference proxy whose currency the backfill may still settle at the source.
 */
export function isReferenceOnly(
  read: Read,
  cache: market.PriceCache,
  instrument: Instrument,
): boolean {
  const referenced = read<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (
       SELECT instrument_id FROM inv_transactions UNION ALL
       SELECT instrument_id FROM inv_position_snapshots UNION ALL
       SELECT instrument_id FROM watchlist_items UNION ALL
       SELECT instrument_id FROM alerts UNION ALL
       SELECT instrument_id FROM inv_profile_instruments
     ) WHERE instrument_id IN (SELECT id FROM inv_instruments WHERE gid IN (${marks(1)}))`,
    instrument.id,
  )[0]?.n;
  if (referenced) return false;
  return market.cachedMarketData(cache, [instrument]).series(instrument.id).length === 0;
}

/**
 * The quote currency the source answered for a reference proxy registered with its market's usual
 * one (Python writes the row directly; here an `instrument.updated` of the shared currency). Leader
 * only, refused once the vault references the instrument.
 */
export const settleProxyCurrency = defineCommand({
  id: "investments.settleProxyCurrency",
  input: z.object({ instrument: z.string().min(1), currency: z.string().min(1) }),
  run(ctx, input): CommandResult<null> {
    if (!ctx.lease.isHolder()) return refuse("not_leader");
    const current = loadInstrument(ctx.read, input.instrument, { shared: true });
    if (current === undefined) return refuse("no_instrument");
    const currency = toCurrency(input.currency);
    if (current.currency === currency) return ok(null);
    ctx.emit("instrument.updated", current.id, { currency });
    return ok(null);
  },
});

function nowOf(env: CommandEnv): DateTime {
  return parseDateTime(new Date(env.clock.now()).toISOString());
}

/** Python `market.upsert_bars` of one instrument's bars (as a one-item fetch report). */
function writeBars(
  cache: market.PriceCache,
  instrument: Instrument,
  bars: readonly PriceBar[],
  now: DateTime,
  asOf: CalendarDate,
): number {
  const item = market.instrumentFetch({
    instrumentId: instrument.id,
    label: instrumentLabel(instrument),
    status: market.FetchStatus.OK,
    bars,
  });
  return market.applyFetchReport(cache, market.fetchReport(asOf, [item]), [instrument], now).bars;
}

/** Bars a split re-fetch replaces (Python's deleted rows: one per instrument and day). */
function replacedBy(
  cache: market.PriceCache,
  report: market.FetchReport,
  instrument: Instrument,
): number {
  let n = 0;
  const series = market.cachedMarketData(cache, [instrument]).series(instrument.id);
  for (const item of report.instruments) {
    if (item.replaceFrom === null) continue;
    const end = item.end ?? report.asOf;
    n += series.filter((b) => (item.replaceFrom as string) <= b.date && b.date <= end).length;
  }
  return n;
}

/** Python `run_backfill` for one vault. Refused off the lease and while another backfill runs. */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  if (!deps.env.lease.isHolder()) return { ok: false, reason: "not_leader" };
  if (running.has(deps.cache)) return { ok: false, reason: "busy" };
  running.add(deps.cache);
  try {
    return { ok: true, value: await run(deps) };
  } finally {
    running.delete(deps.cache);
  }
}

interface PendingProxy {
  readonly proxy: string;
  readonly first: CalendarDate;
  readonly guess: Currency;
}

async function run(deps: BackfillDeps): Promise<perf.BackfillReport> {
  const { store, cache, asOf, strategy } = deps;
  const read: Read = store.read.bind(store);
  const report = perf.backfillReport(asOf);
  report.profiles.push(deps.profile);
  const profile = profileOf(read);
  const base = perf.baseCurrencyOf(
    profile === undefined ? null : toCurrency(profile.baseCurrency),
    strategy,
  );
  const plan = perf.planBackfill({
    txns: transactions(read),
    renames: renames(read),
    load: (ids) =>
      new Map([...loadInstruments(read, ids)].map(([k, i]) => [asInstrumentId(k), i] as const)),
    base,
    asOf,
  });
  const proxies: PendingProxy[] = [];
  const added = new Set<string>();
  const bench = strategy.strategy === null ? null : strategy.benchmark;
  if (plan.first !== null && bench !== null) {
    const ensured = ensureProxy(deps, bench.proxy); // registers a market symbol offline
    const proxy = ensured.instrument;
    if (ensured.status === "added") added.add(bench.proxy.trim().toUpperCase());
    if (proxy === null || isReferenceOnly(read, cache, proxy)) {
      // unknown, or a reference proxy without bars yet: probe it at the source
      proxies.push({
        proxy: bench.proxy,
        first: plan.first,
        guess: proxy?.currency ?? bench.currency ?? base,
      });
    } else {
      report.benchmarks.push({
        profile: deps.profile,
        proxy: bench.proxy,
        status: "found",
        instrumentId: proxy.id,
        message: null,
      });
      perf.planBenchmark(plan, proxy, plan.first);
    }
  }
  if (plan.instruments.size === 0 && proxies.length === 0 && plan.currencies.size === 0) {
    return report;
  }
  await resolveProxies(deps, plan, proxies, added, report);
  const refresher = new market.MarketDataRefresher(
    deps.sources.prices,
    deps.sources.fx,
    deps.refresher,
  );
  for (const [iid, instrument] of plan.instruments) {
    const result: perf.InstrumentBackfill = {
      instrumentId: iid,
      label: instrumentLabel(instrument),
      role: plan.roles.get(iid) ?? "sold",
      needFrom: addDays(plan.needFrom.get(iid) as CalendarDate, -perf.HEAD_MARGIN_DAYS),
      status: "ok",
      head: null,
      barsWritten: 0,
      barsReplaced: 0,
      messages: [],
    };
    report.instruments.push(result);
    await backfillInstrument(deps, instrument, result, plan, refresher);
  }
  const instruments = [...plan.instruments.values()];
  const stored = market.cachedMarketData(
    cache,
    instruments,
    deps.order === undefined ? {} : { order: deps.order },
  );
  const fxHistoryFrom = new Map(
    [...plan.currencies].map(([c, d]) => [c, addDays(d, -perf.HEAD_MARGIN_DAYS)] as const),
  );
  const currencies = [...plan.currencies.keys()].sort();
  const fxReport = await refresher.refresh(stored, [], currencies, asOf, { fxHistoryFrom });
  report.ratesWritten = market.applyFetchReport(cache, fxReport, [], nowOf(deps.env)).rates;
  report.fx = fxReport.fx.map((f) => ({
    currency: f.currency,
    status: f.status,
    start: f.start,
    rates: f.rates.length,
    message: f.message,
  }));
  return report;
}

export type EnsuredProxy =
  | { readonly status: "found" | "added"; readonly instrument: Instrument }
  | { readonly status: "unresolved"; readonly instrument: null };

/**
 * Python `proxy.ensure_proxy`: the instrument of a strategy's `benchmark.proxy`, registered as a
 * reference instrument (market data only: no position, watchlist item or signal) when the symbol
 * names a known market. No network. The strategy loader calls it when a strategy is recorded.
 */
export function ensureProxy(
  deps: Pick<BackfillDeps, "store" | "writer" | "env">,
  proxy: string,
): EnsuredProxy {
  const found = findProxy(deps.store.read.bind(deps.store), proxy);
  if (found !== undefined) return { status: "found", instrument: found };
  const planned = perf.referenceInstrument(proxy);
  if (planned === null) return { status: "unresolved", instrument: null };
  return { status: "added", instrument: createProxy(deps, planned) };
}

/** Register a planned instrument through `createInstrument` (aliases as planned) and load it. */
function createProxy(
  deps: Pick<BackfillDeps, "store" | "writer" | "env">,
  planned: Instrument,
): Instrument {
  const out = runCommand(
    deps.store,
    deps.writer,
    createInstrument,
    {
      name: planned.name,
      currency: planned.currency,
      assetClass: planned.assetClass,
      symbol: planned.symbol ?? "",
      mic: planned.mic ?? "",
      aliases: planned.aliases.map((a) => ({
        namespace: a.namespace,
        value: a.value,
        guessed: a.guessed,
      })),
    },
    deps.env,
  );
  if (!out.ok) throw new Error(`could not register the benchmark proxy: ${out.reason}`);
  const stored = loadInstrument(deps.store.read.bind(deps.store), out.value.gid, { shared: true });
  if (stored === undefined) throw new Error("the registered benchmark proxy is not in the view");
  return stored;
}

/** Python `_resolve_proxies`. */
async function resolveProxies(
  deps: BackfillDeps,
  plan: perf.BackfillPlan,
  proxies: readonly PendingProxy[],
  added: ReadonlySet<string>,
  report: perf.BackfillReport,
): Promise<void> {
  const probed = new Map<string, perf.ProbeResult>();
  const read: Read = deps.store.read.bind(deps.store);
  for (const { proxy, first, guess } of proxies) {
    if (perf.isIsin(proxy)) {
      report.benchmarks.push({
        profile: deps.profile,
        proxy,
        status: "not_found",
        instrumentId: null,
        message:
          "an ISIN proxy must be an instrument already stored (import or add it); a Yahoo " +
          "symbol is added automatically",
      });
      continue;
    }
    const key = proxy.trim().toUpperCase(); // Yahoo symbols are case-insensitive, stored upper-case
    let answer = probed.get(key);
    if (answer === undefined) {
      answer = await perf.probeProxy(deps.sources.prices, key, guess, deps.asOf);
      probed.set(key, answer);
    }
    const existing = findProxy(read, key) ?? null;
    let stored: Instrument;
    let status: "found" | "added" | null;
    if (!answer.ok) {
      report.benchmarks.push({
        profile: deps.profile,
        proxy,
        status: "error",
        instrumentId: null,
        message: answer.message,
      });
      if (existing === null) continue;
      stored = existing; // registered offline: its other aliases may work
      status = null;
    } else if (existing === null) {
      stored = createProxy(deps, answer.instrument);
      status = "added";
    } else {
      stored = existing;
      status = added.has(key) ? "added" : "found";
      if (
        answer.instrument.currency !== existing.currency &&
        isReferenceOnly(read, deps.cache, existing)
      ) {
        // a reference proxy registered with the market's usual currency: the source quotes it in
        // another one (nothing references it yet, so it is safe to fix)
        const out = runCommand(
          deps.store,
          deps.writer,
          settleProxyCurrency,
          { instrument: existing.id, currency: answer.instrument.currency },
          deps.env,
        );
        if (!out.ok) throw new Error(`could not settle the proxy currency: ${out.reason}`);
        stored = loadInstrument(read, existing.id, { shared: true }) ?? existing;
      }
    }
    if (status !== null) {
      report.benchmarks.push({
        profile: deps.profile,
        proxy,
        status,
        instrumentId: stored.id,
        message: null,
      });
    }
    perf.planBenchmark(plan, stored, first);
  }
}

/** Python `_backfill_instrument`. */
async function backfillInstrument(
  deps: BackfillDeps,
  instrument: Instrument,
  result: perf.InstrumentBackfill,
  plan: perf.BackfillPlan,
  refresher: market.MarketDataRefresher,
): Promise<void> {
  const { cache, asOf } = deps;
  if (!fetchesMarketData(instrument)) {
    result.status = "skipped";
    result.messages.push(`not fetched: instrument is ${instrument.status}`);
    return;
  }
  const stored = market.cachedMarketData(
    cache,
    [instrument],
    deps.order === undefined ? {} : { order: deps.order },
  );
  const needFrom = result.needFrom;
  const first = stored.firstBarDate(instrument.id);
  let headEnd: CalendarDate | null = null;
  if (first === null) headEnd = asOf;
  else if (daysBetween(needFrom, first) > perf.HEAD_TOLERANCE_DAYS) {
    headEnd = addDays(first, -1);
  }
  let freshOnly = first === null;
  if (headEnd !== null && needFrom <= headEnd) {
    result.head = [needFrom, headEnd];
    let bars: PriceBar[] = [];
    try {
      const answer = await deps.sources.prices.fetch(instrument, needFrom, headEnd);
      bars = answer.bars.filter(
        (b) =>
          b.instrumentId === instrument.id && needFrom <= b.date && b.date <= (headEnd as string),
      );
    } catch (error) {
      result.status = "error";
      result.messages.push(
        error instanceof market.SourceException
          ? `history ${needFrom}..${headEnd}: ${error.sourceId}: ${error.detail}`
          : `history ${needFrom}..${headEnd}: ${error instanceof Error ? error.name : "Error"}`,
      );
      freshOnly = false;
    }
    if (bars.length > 0) {
      result.barsWritten += writeBars(cache, instrument, bars, nowOf(deps.env), asOf);
    } else if (result.status !== "error") {
      result.messages.push(`no bars for ${needFrom}..${headEnd}`);
      if (first === null) {
        result.status = "no_data";
        freshOnly = false;
      }
    }
  }
  if (freshOnly && result.barsWritten) return; // the whole history was fetched just now
  const split = plan.splitDates.get(instrument.id);
  const tail = await refresher.refresh(stored, [instrument], [], asOf, {
    ...(split === undefined ? {} : { splitDates: new Map([[instrument.id, split]]) }),
  });
  const replaced = replacedBy(cache, tail, instrument);
  result.barsWritten += market.applyFetchReport(cache, tail, [instrument], nowOf(deps.env)).bars;
  result.barsReplaced += replaced;
  for (const item of tail.instruments) {
    if (item.message) result.messages.push(item.message);
    if (item.status === market.FetchStatus.ERROR) result.status = "error";
    else if (
      item.status === market.FetchStatus.NO_DATA &&
      result.status === "ok" &&
      first === null
    ) {
      result.status = "no_data";
    }
  }
}
