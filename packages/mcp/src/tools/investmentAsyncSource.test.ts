/** Actual isolated Python byte oracle. Expected trees are never inputs to native services. */
import { addDays, D, parseDateTime, sha256Hex, toCurrency } from "@cashu/domain";
import { asInstrumentId, asProfileId, market, priceBar } from "@cashu/domain/investments";
import { investmentsCommands as C } from "@cashu/store";
import {
  type ImportPublication,
  InstrumentSearch,
  loadStrategy,
} from "@cashu/store/investments/services";
import { afterEach, expect, it } from "vitest";
import { type JsonValue, pyDumps } from "../privacy/pyJson.js";
import { investmentSearchIo, investmentWatchIo } from "../providers/investmentAsyncTypes.js";
import { investmentWriteServices } from "../providers/investmentWrites.js";
import { decodeEntityRef, type EntityRefKind, encodeEntityRef } from "../runtime/refs.js";
import { NativeMcpServer } from "../runtime/server.js";
import { asyncFixture } from "../testing/async.js";
import vectors from "./fixtures/investmentAsync.json" with { type: "json" };
import { investmentImportAdapter } from "./investmentImportProposal.js";
import { investmentSearchAdapter } from "./investmentSearch.js";
import { investmentWatchAdapter } from "./investmentWatch.js";
import { investmentWriteTools } from "./investmentWrites.js";

const opened: ReturnType<typeof asyncFixture>[] = [];
afterEach(() => {
  for (const s of opened.splice(0)) s.f.close();
});
const FILE = new TextEncoder().encode(
  "format_version,record,date,time,type,external_ref,symbol,isin,name,exchange,quantity,price,currency,gross_amount,fee,tax,cash_amount,cash_currency,fx_rate,split_ratio,source\n1,txn,2026-01-01,,deposit,D,,,,,,,PLN,,,,1000,PLN,,,generic_csv\n",
);
const hits = () =>
  market.parseYahooSearch(
    JSON.stringify({
      quotes: [
        { symbol: "ABC.WA", shortname: "Synthetic Public", quoteType: "EQUITY", exchange: "WSE" },
      ],
    }),
  );
function quote(symbol: string): market.ChartQuote {
  return {
    symbol,
    currency: toCurrency("PLN"),
    instrumentType: "EQUITY",
    longName: "Synthetic Public",
    exchangeName: "WSE",
    splits: [],
    adjusted: [],
    bars: Array.from({ length: 22 }, (_, i) =>
      priceBar({
        instrumentId: asInstrumentId("chart"),
        date: addDays("2026-10-10", i),
        close: D(String(100 + i)),
        source: "yahoo",
        currency: toCurrency("PLN"),
      }),
    ),
  };
}
const kinds: Readonly<Record<string, EntityRefKind>> = {
  instrument_id: "instrument",
  item_id: "watchlist",
  proposal_id: "proposal",
};
function normalized(value: JsonValue, refs: ReadonlyMap<string, string>): JsonValue {
  if (Array.isArray(value)) return value.map((v) => normalized(v, refs));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => {
        if (kinds[key] && typeof v === "string") {
          decodeEntityRef(kinds[key], v);
          const label = refs.get(v);
          if (!label) throw new Error("unknown typed oracle ref");
          return [key, label];
        }
        if (key === "key" && typeof v === "string" && v.startsWith("i:")) {
          const ref = v.slice(2);
          decodeEntityRef("instrument", ref);
          const label = refs.get(ref);
          if (!label) throw new Error("unknown typed local search key");
          return [key, `i:${label}`];
        }
        return [key, normalized(v, refs)];
      }),
    );
  return value;
}
it.each(["strict", "amounts"] as const)(
  "matches actual Python async source wire in %s after real privacy",
  async (privacy) => {
    const s = asyncFixture();
    opened.push(s);
    s.f.run((await import("@cashu/store")).setProfileSettings, { mcpPrivacy: privacy });
    const account = s.f.run(C.addBrokerageAccount, { name: "Synthetic broker", broker: "dif" });
    if (!account.ok) throw new Error(account.reason);
    const strategy = await loadStrategy(s.f.store, {
      read: async (name) =>
        name === "strategy.yaml"
          ? "version: 1\nbase_currency: PLN\ndata: {max_stale_weight: 1}\n"
          : null,
      write: async () => {},
      exists: async () => true,
    });
    const searchService = new InstrumentSearch(() => 1);
    const sourceFactory = () => ({
      symbols: {
        async search() {
          return hits();
        },
      },
      close() {},
    });
    const search = investmentSearchIo(s.f.vault, searchService, sourceFactory, () => true);
    const watch = investmentWatchIo(
      s.f.vault,
      {
        async chart(symbol) {
          return quote(symbol);
        },
        async search(query) {
          return (await searchService.remoteHits(query, sourceFactory)).hits;
        },
      },
      s.f.prices,
      () => true,
    );
    const blobs = new Map<string, Uint8Array>();
    const imports: ImportPublication = {
      vault: s.f.vault,
      binding: Object.freeze({}),
      isCurrent: () => true,
      async publish(content, expected) {
        const blob = { sha256: sha256Hex(content), ext: expected.ext };
        blobs.set(blob.sha256, Uint8Array.from(content));
        return { blob, privateStage: null };
      },
      async read(vault, blob) {
        if (vault !== s.f.vault) throw new Error("foreign synthetic reader");
        const b = blobs.get(blob.sha256);
        return b ? Uint8Array.from(b) : null;
      },
      async discardPrivateStage() {
        throw new Error("no private stage issued");
      },
    };
    s.services((ctx) => ({
      investmentAsync: { vault: s.f.vault, search, watch, imports },
      readInvestmentImportFile: (path) => ({
        name: path === "/blocked.csv" ? "blocked.csv" : "synthetic.csv",
        bytes: path === "/blocked.csv" ? new TextEncoder().encode("not an export\n") : FILE,
      }),
      investmentWrites: investmentWriteServices(ctx, {
        portfolio: {
          vault: asProfileId(s.f.vault),
          asOf: ctx.today,
          clock: {
            today: ctx.today,
            now: parseDateTime(new Date(ctx.store.now()).toISOString()),
            timeZone: "UTC",
          },
          strategy,
          lang: "pl",
          forOwner: false,
          prices: s.f.prices,
        },
        isHolder: () => false,
      }),
    }));
    const server = new NativeMcpServer(s.runtime, investmentWriteTools(), [
      investmentSearchAdapter,
      investmentWatchAdapter,
      investmentImportAdapter,
    ]);
    const responses: Record<string, JsonValue> = {},
      refs = new Map<string, string>();
    const call = async (label: string, tool: string, args: Record<string, unknown>) => {
      const result = await server.call(tool, args);
      expect(result.ok, label).toBe(true);
      if (!result.data) throw new Error("missing native oracle data");
      responses[label] = result.data;
      return result.data as Record<string, JsonValue>;
    };
    const watchRefs = (value: Record<string, JsonValue>, label: string) => {
      const item = value.item as Record<string, JsonValue>,
        instrument = item.instrument as Record<string, JsonValue>;
      refs.set(String(instrument.instrument_id), `instrument_${label}`);
      refs.set(String(item.item_id), `watch_${label}`);
    };
    await call("search_remote", "search_instruments", { query: "ABC" });
    watchRefs(
      await call("watch_public", "add_to_watchlist", { symbol_or_isin: "ABC.WA" }),
      "public",
    );
    await call("search_local", "search_instruments", { query: "ABC" });
    watchRefs(
      await call("watch_private", "add_to_watchlist", {
        symbol_or_isin: "PRIV",
        name: "Synthetic Private Owner",
        currency: "PLN",
        note: "Synthetic Private Owner",
      }),
      "private",
    );
    watchRefs(
      await call("watch_numeric", "add_to_watchlist", { symbol_or_isin: "1234.WA" }),
      "numeric",
    );
    const args = {
      path: "/synthetic.csv",
      account: encodeEntityRef("account", account.value.account),
      importer: "cashu",
    };
    const proposed = await call("import", "propose_import", {
      ...args,
      reason: "Synthetic pending import",
    });
    refs.set(String(proposed.proposal_id), "proposal_import");
    await call("import_blocked", "propose_import", { ...args, path: "/blocked.csv" });
    // Native and Python refs are canonicalized only after their real redaction/leak checks.
    expect(pyDumps(normalized(responses, refs), { sortKeys: true })).toBe(vectors[privacy].wire);
  },
);
