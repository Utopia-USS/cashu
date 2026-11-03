/** Bounded search/chart phases, followed by actual watch effects and genuine prospective projection. */
import { parseDateTime } from "@cashu/domain";
import { asInstrumentId, market } from "@cashu/domain/investments";
import { loadInstrument, overrides, vaultInstrumentGids } from "@cashu/store/investments/queries";
import {
  addWatchWithPlans,
  needsWatchIo,
  prepareWatchResolution,
  type WatchAddRequest,
  type WatchFailure,
  type WatchResolutionAnswers,
  type WatchWarning,
} from "@cashu/store/investments/services";
import * as L from "../privacy/labels.js";
import type { InvestmentWatchIo } from "../providers/investmentAsyncTypes.js";
import { investmentNameSources } from "../providers/investments.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import {
  type NativeAsyncAdapter,
  type NativeAsyncValue,
  type NativePreparationStore,
  ownedValue,
} from "../runtime/async.js";
import { object, quoteDto, quoteFromDto, text } from "./investmentAsyncData.js";
import { execute, instrument } from "./investmentWriteSupport.js";
import { validateWatchArguments, watchRow } from "./investmentWrites.js";

type Context = ToolContext<NativePreparationStore>;
const vaultId = (ctx: Context) => ctx.profileId.toString(16).padStart(32, "0");
function ioOf(ctx: Context): InvestmentWatchIo | undefined {
  const all = ctx.store.investmentAsync,
    io = all?.watch;
  if (all && (all.vault !== vaultId(ctx) || (io && io.vault !== vaultId(ctx))))
    throw new Error("watch vault binding mismatch");
  if (io && !io.isCurrent())
    throw new ToolError("native watch capability is unavailable", "unavailable", { system: true });
  return io;
}
function request(ctx: Context, args: ToolArgs): WatchAddRequest {
  const { raw, explicit } = validateWatchArguments(ctx, args);
  // Existing local writes and new writes both need the genuine decorated-response projection.
  if (!ctx.store.investmentWrites)
    throw new ToolError("native investment market context is unavailable", "unsupported");
  return {
    target: explicit
      ? { instrument: instrument(ctx, raw, true) }
      : {
          text: raw,
          name: typeof args.name === "string" ? args.name : null,
          currency: typeof args.currency === "string" ? args.currency : null,
          exchange: typeof args.exchange === "string" ? args.exchange : null,
        },
    note: typeof args.note === "string" ? args.note : null,
    source: "agent",
    today: ctx.today,
  };
}
function answers(raw: NativeAsyncValue | undefined, unavailable: boolean): WatchResolutionAnswers {
  if (raw === undefined) return { unavailable };
  const state = object(raw);
  const search = state.search === undefined ? undefined : object(state.search);
  const chart = state.chart === undefined ? undefined : object(state.chart);
  if (search && !Array.isArray(search.hits)) throw new Error("invalid watch search response");
  return {
    unavailable,
    ...(search
      ? {
          search: {
            query: text(search.query),
            hits: search.hits as unknown as readonly market.SearchHit[],
          },
        }
      : {}),
    ...(chart
      ? { chart: { symbol: text(chart.symbol), quote: quoteFromDto(chart.quote ?? null) } }
      : {}),
  };
}
function refusal(out: WatchFailure): never {
  const messages: Record<string, string> = {
    symbol_required: "symbol_or_isin is required",
    symbol_invalid:
      "symbol_or_isin must be a ticker or an ISIN (letters, digits and . : - _ ^ =, up to 40)",
    name_too_long: "name is too long (max 120 characters)",
    currency_invalid: "currency must be a 3-letter currency code (e.g. EUR)",
    unknown_exchange: "unknown exchange",
    note_too_long: "note is too long (max 1000 characters)",
    watchlist_full: "watchlist is full (max 200)",
    unknown_market: `market is unknown for ${String(out.params.text ?? "")}; pass an exchange or currency, or choose an exact Yahoo symbol from search_instruments`,
    unknown_isin: `no known listing for ${String(out.params.isin ?? "")}; pass a currency to save it without prices`,
    unknown_currency: `currency is unknown for ${String(out.params.symbol ?? "")}`,
  };
  if (out.reason === "several_listings") {
    const candidates = Array.isArray(out.params.candidates)
      ? (out.params.candidates as { symbol: string; exchange: string | null }[])
      : [];
    throw new ToolError(
      `several listings match ${String(out.params.text ?? "")}: ${candidates.map((c) => `${c.symbol}${c.exchange ? ` (${c.exchange})` : ""}`).join(", ")}; choose an exact Yahoo symbol from search_instruments`,
    );
  }
  throw new ToolError(messages[out.reason] ?? `watchlist resolution refused: ${out.reason}`);
}
function warning(w: WatchWarning): string {
  const p = w.params;
  if (w.code === "watchlist.unverified_price_symbol")
    return `The price symbol ${p.symbol} could not be verified (no prices yet); it is kept as a guess (check it in the instrument classification if no prices arrive)`;
  if (w.code === "watchlist.no_price_symbol")
    return `No Yahoo symbol known for ${p.isin}: prices are not fetched until one is set (instrument classification, alias yahoo)`;
  return `New instrument ${p.symbol} (${p.currency}); price symbol guessed as ${p.price_symbol ?? "None"} (check it in the instrument classification if no prices arrive)`;
}
export const investmentWatchAdapter: NativeAsyncAdapter = {
  name: "add_to_watchlist",
  maxIoPhases: 2,
  current(ctx, previous) {
    const io = ioOf(ctx);
    return io !== undefined && io.binding === previous.binding && io.isCurrent();
  },
  advance(ctx, args, resume) {
    const preparedRequest = request(ctx, args),
      io = ioOf(ctx);
    const out = prepareWatchResolution(
      ctx.store.read,
      preparedRequest,
      answers(resume, io === undefined),
    );
    if (!out.ok) {
      if (needsWatchIo(out)) {
        if (!io) throw new Error("watch I/O requested without capability");
        return {
          kind: "io",
          io,
          operation: ownedValue({ operation: out.operation, state: resume ?? {} }),
        };
      }
      refusal(out);
    }
    // Recompute the actual target in finish; never retain read-derived planned/local instrument rows.
    return { kind: "ready", ready: resume ?? {} };
  },
  async perform(raw, base, signal) {
    const step = object(raw),
      operation = object(step.operation ?? null),
      state = object(step.state ?? {}),
      io = base as InvestmentWatchIo;
    if (operation.kind === "search") {
      let hits: readonly market.SearchHit[] = [];
      try {
        hits = await io.search(text(operation.query), signal);
      } catch {
        /* source unavailable fallback */
      }
      return ownedValue({ ...state, search: { query: text(operation.query), hits } });
    }
    if (operation.kind !== "chart") throw new Error("invalid watch operation");
    let quote = null;
    try {
      quote = await io.chart(
        text(operation.symbol),
        text(operation.start),
        text(operation.end),
        signal,
      );
    } catch {
      /* source unverified fallback */
    }
    return ownedValue({
      ...state,
      chart: { symbol: text(operation.symbol), quote: quoteDto(quote) },
    });
  },
  async finish(ctx, args, ready) {
    const preparedRequest = request(ctx, args),
      io = ioOf(ctx);
    const resolution = prepareWatchResolution(
      ctx.store.read,
      preparedRequest,
      answers(ready, io === undefined),
    );
    if (!resolution.ok) {
      if (needsWatchIo(resolution))
        throw new ToolError("the instrument changed while resolving; try again", "conflict");
      refusal(resolution);
    }
    const r = resolution.value,
      service = ctx.store.investmentWrites;
    if (!service)
      throw new ToolError("native investment market context is unavailable", "unsupported");
    const target =
      r.kind === "planned"
        ? { planned: r.planned, ...(r.yahooSymbol === null ? {} : { yahooSymbol: r.yahooSymbol }) }
        : "instrument" in preparedRequest.target
          ? { instrument: r.instrument }
          : { stored: r.instrument };
    const saved = await execute(ctx, addWatchWithPlans(service.plans), {
      target,
      note: preparedRequest.note,
      source: "agent",
    });
    const bars =
      saved.createdInstrument && r.kind === "planned" && r.quote !== null
        ? r.quote.bars.map((b) => ({ ...b, instrumentId: asInstrumentId(saved.instrument) }))
        : undefined;
    const currentService = ctx.store.investmentWrites;
    if (!currentService)
      throw new ToolError("native investment market context is unavailable", "unsupported");
    const row = currentService
      .watchlist({ ...saved, ...(bars === undefined ? {} : { verifiedBars: bars }) })
      .find((w) => w.id === saved.item);
    if (!row) throw new Error("prospective watch row missing");
    const warnings =
      saved.createdInstrument && r.kind === "planned"
        ? r.warnings.map((w) => L.text(warning(w)))
        : [];
    const answer = {
      item: watchRow(ctx, row, saved.prospectiveInstrument),
      created_instrument: L.flag(saved.createdInstrument),
      restored: L.flag(saved.restored),
      warnings,
    };
    const shared =
      loadInstrument(ctx.store.read, saved.instrument, { shared: true }) ??
      saved.prospectiveInstrument;
    const providers = [
      investmentNameSources([
        {
          inProfile: true,
          own: saved.prospectiveInstrument,
          shared,
          overrideName:
            overrides(ctx.store.read, [saved.instrument]).get(saved.instrument)?.name ?? null,
        },
      ]),
    ];
    // This read is still pre-append. REFERENCES includes overrides and removed watch rows, matching
    // loadNameSources' actual membership: an already referenced target contributes these inputs now.
    // Re-adding its alias pairs would change sequential replacement semantics and fail delivery.
    const prospectiveNames = vaultInstrumentGids(ctx.store.read).has(saved.instrument)
      ? undefined
      : { profileId: ctx.profileId, providers };
    if (
      !saved.createdInstrument ||
      r.kind !== "planned" ||
      r.quote === null ||
      r.yahooSymbol === null
    )
      return { answer, prospectiveNames };
    if (!io) throw new Error("verified watch has no cache publication capability");
    return {
      answer,
      prospectiveNames,
      cacheFailureAnswer: {
        ...answer,
        warnings: [
          ...warnings,
          L.fixedText(
            "watch saved; the price cache could not be updated; a later refresh can retry",
          ),
        ],
      },
      afterCommit: {
        io,
        data: {
          symbol: r.yahooSymbol,
          quote: quoteDto(r.quote),
          at: new Date(ctx.store.now()).toISOString(),
        },
      },
    };
  },
  afterCommit(raw, base) {
    const data = object(raw),
      quote = quoteFromDto(data.quote ?? null),
      io = base as InvestmentWatchIo;
    if (!quote || !io.publishBars) throw new Error("watch cache writer unavailable");
    return io.publishBars(
      market.marketSymbol("yahoo", text(data.symbol)),
      quote.bars.map((b) => ({
        date: b.date,
        close: b.close,
        open: b.open,
        high: b.high,
        low: b.low,
        volume: b.volume,
        currency: b.currency,
        fetchedAt: b.fetchedAt,
      })),
      parseDateTime(text(data.at)),
    );
  },
};
