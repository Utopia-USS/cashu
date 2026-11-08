// Test support: the old one-call watchlist add (Python `service/watchlist.py` `add`). It drives
// `prepareWatchResolution` through its search / chart phases against a market port, then runs the
// `addToWatchlist` command and caches the verified bars. The shipped host (signalsScreen.ts) and
// MCP (investmentWatch.ts) run their own drivers; the watchlist tests use this one.
import { type DateTime, parseDateTime } from "@cashu/domain";
import { AliasNamespace, market } from "@cashu/domain/investments";
import { type CommandEnv, type EventWriter, runCommand } from "../../../command.js";
import type { Store } from "../../../materialize.js";
import { addToWatchlist, MAX_ITEMS } from "../../commands/watchlist.js";
import { watchedItemFor } from "../../queries/alerts.js";
import type { Read } from "../../queries/shared.js";
import { type WatchTargetRef, watchTargetInstrument } from "../../queries/watchlist.js";
import {
  needsWatchIo,
  prepareWatchResolution,
  type WatchAddOutcome,
  type WatchAddRequest,
  type WatchFailure,
  type WatchlistMarket,
  type WatchResolution,
  type WatchResolutionAnswers,
} from "../watchlist.js";

type Outcome<T> = { readonly ok: true; readonly value: T } | WatchFailure;
const fail = (reason: string, params: Readonly<Record<string, unknown>> = {}): WatchFailure => ({
  ok: false,
  reason,
  params,
});

export interface WatchlistServiceDeps {
  readonly store: Store;
  readonly writer: EventWriter;
  readonly env: CommandEnv;
  readonly market: WatchlistMarket;
  /** The device-local price cache (keyed by market symbol). */
  readonly prices: market.PriceCache;
}

async function resolveService(
  read: Read,
  port: WatchlistMarket,
  request: WatchAddRequest,
): Promise<Outcome<WatchResolution>> {
  let answers: WatchResolutionAnswers = {};
  for (let phase = 0; phase <= 2; phase++) {
    const result = prepareWatchResolution(read, request, answers);
    if (result.ok || !needsWatchIo(result)) return result;
    const operation = result.operation;
    if (operation.kind === "search") {
      let hits: readonly market.SearchHit[] = [];
      try {
        hits = await port.search(operation.query);
      } catch {
        /* source unavailable */
      }
      answers = { ...answers, search: { query: operation.query, hits } };
    } else {
      let quote: market.ChartQuote | null = null;
      try {
        quote = await port.chart(operation.symbol, operation.start, operation.end);
      } catch {
        /* unverified */
      }
      answers = { ...answers, chart: { symbol: operation.symbol, quote } };
    }
  }
  return fail("remote_phase_limit");
}

function nowOf(env: CommandEnv): DateTime {
  return parseDateTime(new Date(env.clock.now()).toISOString());
}

/**
 * Python `add`: put an instrument on the vault's watchlist. Checks in Python's order (note / tags,
 * the item limit, the resolution with its network, then the command, which re-checks everything
 * against the view it writes on). An instrument whose row was removed gets that row back. Warnings
 * and the verified bars belong to an instrument this add created.
 */
export async function addToWatchlistService(
  deps: WatchlistServiceDeps,
  request: WatchAddRequest,
): Promise<WatchAddOutcome> {
  const read: Read = (sql, ...params) => deps.store.read(sql, ...params);
  const t = request.target;
  const resolution = await resolveService(read, deps.market, request);
  if (!resolution.ok) return resolution;
  const r = resolution.value;
  const target: WatchTargetRef =
    r.kind === "planned"
      ? { planned: r.planned, ...(r.yahooSymbol === null ? {} : { yahooSymbol: r.yahooSymbol }) }
      : "instrument" in t
        ? { instrument: r.instrument }
        : { stored: r.instrument };

  const out = runCommand(
    deps.store,
    deps.writer,
    addToWatchlist,
    {
      target,
      note: request.note ?? null,
      tags: request.tags ?? null,
      source: request.source ?? "user",
      keepExistingNote: request.keepExistingNote ?? false,
    },
    deps.env,
  );
  if (!out.ok) {
    if (out.reason === "already_watched") {
      const instrument = watchTargetInstrument(read, target);
      const item = instrument === undefined ? undefined : watchedItemFor(read, instrument);
      return fail("already_watched", { item: item?.gid ?? null });
    }
    return fail(out.reason, out.reason === "watchlist_full" ? { max: MAX_ITEMS } : {});
  }
  // PARITY(S22b): Python's free-text paths insert unconditionally (always "created", with warnings);
  // `storeInstrument` reuses an instrument that took the creation alias meanwhile, so warnings (and
  // the bars, written to the device cache after the batch instead of in its transaction) belong to
  // a created instrument only. Differs from Python only in a race.
  const created = out.value.createdInstrument;
  if (created && r.kind === "planned" && r.quote !== null && r.yahooSymbol !== null) {
    deps.prices.upsertBars(
      market.marketSymbol(AliasNamespace.YAHOO, r.yahooSymbol),
      r.quote.bars.map((b) => ({
        date: b.date,
        close: b.close,
        open: b.open,
        high: b.high,
        low: b.low,
        volume: b.volume,
        currency: b.currency,
        fetchedAt: b.fetchedAt,
      })),
      nowOf(deps.env),
    );
  }
  return {
    ok: true,
    value: { ...out.value, warnings: created && r.kind === "planned" ? r.warnings : [] },
  };
}
