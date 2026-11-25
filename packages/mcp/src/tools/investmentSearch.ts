/** Public network lookup followed by fresh local ranking, membership, names and alias ownership. */
import { pyLen } from "@cashu/domain/text";
import { loadInstruments, vaultInstrumentGids } from "@cashu/store/investments/queries";
import {
  cleanSearchQuery,
  type InstrumentSearchHit,
  projectInstrumentSearch,
} from "@cashu/store/investments/services";
import * as L from "../privacy/labels.js";
import type {
  InvestmentSearchAnswer,
  InvestmentSearchIo,
} from "../providers/investmentAsyncTypes.js";
import { ownerNamed } from "../providers/investments.js";
import { type ToolArgs, type ToolContext, ToolError } from "../registry.js";
import {
  type NativeAsyncAdapter,
  type NativeAsyncIo,
  type NativeAsyncValue,
  type NativePreparationStore,
  ownedValue,
} from "../runtime/async.js";
import { encodeEntityRef } from "../runtime/refs.js";
import type { NativeToolStore } from "../runtime/types.js";
import * as F from "./researchLabels.js";

function query(args: Readonly<ToolArgs>): string {
  try {
    return cleanSearchQuery(typeof args.query === "string" ? args.query : null);
  } catch {
    throw new ToolError("query must be non-empty and at most 60 characters");
  }
}
const ioOf = (ctx: ToolContext<NativePreparationStore>): InvestmentSearchIo | undefined => {
  const all = ctx.store.investmentAsync;
  if (all === undefined) return undefined;
  const vault = ctx.profileId.toString(16).padStart(32, "0");
  if (all.vault !== vault || (all.search && all.search.vault !== vault))
    throw new Error("search vault binding mismatch");
  const io = all.search;
  if (io && !io.isCurrent())
    throw new ToolError("native search capability is unavailable", "unavailable", { system: true });
  return io;
};
function result(
  ctx: ToolContext<NativeToolStore>,
  args: Readonly<ToolArgs>,
  answer?: InvestmentSearchAnswer,
): L.LabelledTree {
  const text = query(args);
  const data = projectInstrumentSearch(
    { read: ctx.store.read, asOf: ctx.today, nameMatch: (inst) => !ownerNamed(inst) },
    text,
    {},
    answer,
  );
  const privateIds = new Set(
    [...loadInstruments(ctx.store.read, vaultInstrumentGids(ctx.store.read))]
      .filter(([, inst]) => ownerNamed(inst))
      .map(([id]) => id),
  );
  const hit = (row: InstrumentSearchHit): L.LabelledTree => {
    const own = row.instrument_id !== null && privateIds.has(row.instrument_id);
    return {
      // Native-only spelling; retain Python's text label rather than widening key privacy.
      key: L.text(
        row.instrument_id === null
          ? row.key
          : `i:${encodeEntityRef("instrument", row.instrument_id)}`,
      ),
      instrument_id: F.ref("instrument", row.instrument_id),
      state: L.category(row.state),
      symbol: own ? L.identifier(row.symbol) : L.symbol(row.symbol),
      yahoo_symbol: L.symbol(row.yahoo_symbol),
      name: own
        ? L.identifier(row.name)
        : L.text(ctx.strict ? ctx.guard.publicName(row.name) : row.name),
      exchange: L.category(row.exchange),
      mic: L.category(row.mic),
      asset_class: L.category(row.asset_class),
      currency: L.category(row.currency),
      isin: L.symbol(row.isin),
      source: L.category(row.source),
    };
  };
  return {
    query: L.text(data.query),
    local: data.local.map(hit),
    remote: data.remote.map(hit),
    remote_status: L.category(data.remote_status),
    note: L.text(
      "local = the profile's instruments (state held | watched | saved); remote = listings found online (state new; currency is the market's usual one, only a hint). Pass a remote yahoo_symbol to add_to_watchlist.",
    ),
  };
}
/** Honest no-source fallback; no claimed awaited publication or lookup. */
export function searchInstruments(
  ctx: ToolContext<NativeToolStore>,
  args: ToolArgs,
): L.LabelledTree {
  return result(ctx, args, {
    hits: [],
    status: pyLen(query(args)) < 2 ? "skipped" : "unavailable",
  });
}
function answerOf(raw: NativeAsyncValue): InvestmentSearchAnswer {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw) || raw instanceof Uint8Array)
    throw new Error("invalid search answer");
  // Public ports are typed; copy and explicitly select the fields used by native projections.
  const answer = raw as unknown as InvestmentSearchAnswer;
  if (!["ok", "skipped", "unavailable"].includes(answer.status) || !Array.isArray(answer.hits))
    throw new Error("invalid search answer");
  for (const hit of answer.hits) {
    for (const key of ["ticker", "name", "quoteType", "assetClass", "source"] as const)
      if (typeof hit[key] !== "string") throw new Error("invalid search hit");
    for (const key of ["yahooSymbol", "exchangeLabel", "mic", "currencyHint", "isin"] as const)
      if (hit[key] !== null && typeof hit[key] !== "string") throw new Error("invalid search hit");
  }
  return answer;
}
export const investmentSearchAdapter: NativeAsyncAdapter = {
  name: "search_instruments",
  maxIoPhases: 1,
  current(ctx, previous) {
    const io = ioOf(ctx);
    return io !== undefined && io.binding === previous.binding && io.isCurrent();
  },
  advance(ctx, args, resume) {
    const text = query(args);
    const io = ioOf(ctx);
    if (resume !== undefined) return { kind: "ready", ready: ownedValue(answerOf(resume)) };
    if (pyLen(text) < 2 || io === undefined)
      return {
        kind: "ready",
        ready: { hits: [], status: pyLen(text) < 2 ? "skipped" : "unavailable" },
      };
    return { kind: "io", io, operation: text };
  },
  async perform(operation, base: NativeAsyncIo, signal) {
    if (typeof operation !== "string") throw new Error("invalid search operation");
    const io = base as InvestmentSearchIo;
    const answer = await io.remoteHits(operation, signal);
    return ownedValue(
      answerOf(
        ownedValue({
          status: answer.status,
          hits: answer.hits.map((hit) => ({
            yahooSymbol: hit.yahooSymbol,
            ticker: hit.ticker,
            name: hit.name,
            quoteType: hit.quoteType,
            assetClass: hit.assetClass,
            exchangeLabel: hit.exchangeLabel,
            mic: hit.mic,
            currencyHint: hit.currencyHint,
            isin: hit.isin,
            source: hit.source,
            market: null,
          })),
        }),
      ),
    );
  },
  finish(ctx, args, ready) {
    return { answer: result(ctx, args, answerOf(ready)) };
  },
};
