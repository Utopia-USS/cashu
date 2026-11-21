/** Local-first interactive public lookup. Name matching is a caller-controlled privacy boundary. */
import { pyCasefold } from "@cashu/domain";
import { codePointCompare } from "@cashu/domain/budget";
import {
  AliasNamespace,
  type Instrument,
  instrumentLabel,
  market,
} from "@cashu/domain/investments";
import { isCombining, pyLen, pySplit, pyUpper } from "@cashu/domain/text";
import { watchlist } from "../queries/alerts.js";
import { heldSince } from "../queries/holdings.js";
import { loadInstruments, vaultInstrumentGids } from "../queries/instruments.js";
import type { Read } from "../queries/shared.js";
import { storedByYahoo } from "../queries/watchlist.js";

export const MAX_SEARCH_QUERY = 60;
export const SEARCH_CACHE_TTL_MS = 600_000;
export const SEARCH_CACHE_SIZE = 64;
export function cleanSearchQuery(q: string | null): string {
  const text = pySplit(q ?? "").join(" ");
  if (!text || pyLen(text) > MAX_SEARCH_QUERY) throw new RangeError("invalid_search_query");
  return text;
}
export function searchFold(text: string): string {
  return [...pyCasefold(text).replaceAll("ł", "l").normalize("NFKD")]
    .filter((c) => !isCombining(c.codePointAt(0) ?? 0))
    .join("");
}
/** Python compares code points; JS string comparison instead compares UTF-16 code units. */
function compareLabels(a: string, b: string): number {
  return codePointCompare(searchFold(a), searchFold(b));
}
export interface InstrumentSearchHit {
  readonly key: string;
  readonly instrument_id: string | null;
  readonly state: "held" | "watched" | "saved" | "new";
  readonly symbol: string;
  readonly yahoo_symbol: string | null;
  readonly name: string;
  readonly exchange: string | null;
  readonly mic: string | null;
  readonly asset_class: string;
  readonly currency: string | null;
  readonly isin: string | null;
  readonly source: "local" | "yahoo" | "openfigi";
}
export interface InstrumentSearchResult {
  readonly query: string;
  readonly local: readonly InstrumentSearchHit[];
  readonly remote: readonly InstrumentSearchHit[];
  readonly remote_status: "skipped" | "unavailable" | "ok";
}
export interface InstrumentSearchSources {
  readonly symbols: market.SymbolSearch | null;
  readonly isin?: market.IsinLookup | null;
  close(): void;
}
/** A service instance owns its public result LRU; no profile rows or names are cached. */
export class InstrumentSearch {
  private readonly clock: () => number;
  private readonly cache = new Map<string, { until: number; hits: readonly market.SearchHit[] }>();
  constructor(clock: () => number) {
    this.clock = clock;
  }
  async remoteHits(text: string, createSources: () => InstrumentSearchSources) {
    text = cleanSearchQuery(text);
    if (pyLen(text) < 2) return { hits: [], status: "skipped" as const };
    const key = pyCasefold(text);
    const cached = this.cache.get(key);
    if (cached && cached.until > this.clock()) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return { hits: [...cached.hits], status: "ok" as const };
    }
    this.cache.delete(key);
    let sources: InstrumentSearchSources | undefined;
    let worked = false;
    let failed = false;
    let hits: readonly market.SearchHit[] = [];
    try {
      sources = createSources();
      if (sources.symbols) {
        try {
          hits = [...(await sources.symbols.search(text))];
          worked = true;
        } catch {
          failed = true;
        }
      }
      if (market.isIsin(text) && sources.isin) {
        try {
          const figi = await sources.isin.lookup(pyUpper(text));
          worked = true;
          const seen = new Set(hits.map((h) => pyUpper(h.yahooSymbol ?? "")));
          hits = [...hits, ...figi.filter((h) => !seen.has(pyUpper(h.yahooSymbol ?? "")))];
        } catch {
          failed = true;
        }
      }
    } catch {
      failed = true;
    } finally {
      try {
        sources?.close();
      } catch {
        failed = true;
      }
    }
    if (!worked) return { hits: [], status: "unavailable" as const };
    if (!failed) {
      this.cache.set(key, { until: this.clock() + SEARCH_CACHE_TTL_MS, hits: [...hits] });
      while (this.cache.size > SEARCH_CACHE_SIZE) {
        const first = this.cache.keys().next().value;
        if (first !== undefined) this.cache.delete(first);
      }
    }
    return { hits, status: "ok" as const };
  }
  async search(
    deps: {
      /** Each read callback must be a short local read phase, never a transaction across network. */
      readonly read: Read;
      readonly asOf: string;
      readonly sources: () => InstrumentSearchSources;
      readonly nameMatch?: (instrument: Instrument) => boolean;
    },
    q: string | null,
    options: { readonly remote?: boolean; readonly limit?: number } = {},
  ): Promise<InstrumentSearchResult> {
    const text = cleanSearchQuery(q);
    const answer =
      options.remote === false || pyLen(text) < 2
        ? undefined
        : await this.remoteHits(text, deps.sources);
    return projectInstrumentSearch(deps, text, options, answer);
  }
}

/** Fresh local ranking and alias membership. MCP invokes this only after remote I/O finishes. */
export function projectInstrumentSearch(
  deps: {
    readonly read: Read;
    readonly asOf: string;
    readonly nameMatch?: (instrument: Instrument) => boolean;
  },
  q: string | null,
  options: { readonly limit?: number } = {},
  answer?: {
    readonly hits: readonly market.SearchHit[];
    readonly status: "skipped" | "unavailable" | "ok";
  },
): InstrumentSearchResult {
  const text = cleanSearchQuery(q);
  const limit = options.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("invalid_search_limit");
  const referenced = vaultInstrumentGids(deps.read);
  const loaded = loadInstruments(deps.read, referenced);
  const folded = searchFold(text);
  const upper = pyUpper(text);
  const rank = (i: Instrument): number | null => {
    const symbol = searchFold(i.symbol ?? "");
    const aliases = i.aliases
      .filter((a) => a.namespace !== AliasNamespace.ISIN)
      .map((a) => searchFold(a.value));
    if (
      (symbol && symbol === folded) ||
      pyUpper(i.isin ?? "") === upper ||
      aliases.includes(folded) ||
      i.aliases.some((a) => a.namespace === AliasNamespace.ISIN && pyUpper(a.value) === upper)
    )
      return 0;
    if (symbol.startsWith(folded) || aliases.some((a) => a.startsWith(folded))) return 1;
    return (deps.nameMatch?.(i) ?? true) && searchFold(i.name).includes(folded) ? 2 : null;
  };
  const states = () => ({
    held: heldSince(deps.read, deps.asOf),
    watched: new Set(watchlist(deps.read).map((w) => w.instrument)),
  });
  const localHit = (
    i: Instrument,
    memberships: ReturnType<typeof states>,
  ): InstrumentSearchHit => ({
    key: `i:${i.id}`,
    instrument_id: i.id,
    state: memberships.held.has(i.id)
      ? "held"
      : memberships.watched.has(i.id)
        ? "watched"
        : "saved",
    symbol: instrumentLabel(i),
    yahoo_symbol: i.aliases.find((a) => a.namespace === AliasNamespace.YAHOO)?.value ?? null,
    name: i.name,
    exchange: market.MIC_LABELS.get(i.mic ?? "") ?? null,
    mic: i.mic,
    asset_class: i.assetClass,
    currency: i.currency,
    isin: i.isin,
    source: "local",
  });
  const memberships = states();
  const local = [...loaded.values()]
    .map((i) => ({ i, rank: rank(i) }))
    .filter((r): r is { i: Instrument; rank: number } => r.rank !== null)
    .sort((a, b) => a.rank - b.rank || compareLabels(instrumentLabel(a.i), instrumentLabel(b.i)))
    .slice(0, limit)
    .map(({ i }) => localHit(i, memberships));
  if (answer === undefined) return { query: text, local, remote: [], remote_status: "skipped" };
  // Re-read current ownership after the await. A remote alias never grants a vault reference.
  const current = vaultInstrumentGids(deps.read);
  const stored = storedByYahoo(
    deps.read,
    answer.hits.flatMap((h) => h.yahooSymbol ?? []),
  );
  const shown = new Set(local.map((h) => h.instrument_id));
  const remote: InstrumentSearchHit[] = [];
  const seen = new Set<string>();
  const extra: string[] = [];
  for (const h of answer.hits) {
    const id = stored.get(pyUpper(h.yahooSymbol ?? ""));
    if (id && current.has(id)) {
      if (!shown.has(id)) {
        shown.add(id);
        extra.push(id);
      }
      continue;
    }
    const key = `y:${h.yahooSymbol}`;
    if (seen.has(key) || remote.length >= limit) continue;
    seen.add(key);
    remote.push({
      key,
      instrument_id: null,
      state: "new",
      symbol: h.ticker,
      yahoo_symbol: h.yahooSymbol,
      name: h.name,
      exchange: h.exchangeLabel,
      mic: h.mic,
      asset_class: h.assetClass,
      currency: h.currencyHint,
      isin: h.isin,
      source: h.source,
    });
  }
  const found = loadInstruments(deps.read, extra);
  const currentStates = states();
  for (const id of extra) {
    const i = found.get(id);
    if (i) local.push(localHit(i, currentStates));
  }
  return { query: text, local, remote, remote_status: answer.status };
}
