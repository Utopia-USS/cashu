import { market } from "@cashu/domain/investments";
import { describe, expect, it } from "vitest";
import { createProfile } from "../../core/commands.js";
import { applyRaw, raw, stock, vault } from "../commands/testing/fixtures.js";
import { cleanSearchQuery, InstrumentSearch, searchFold } from "./instrumentSearch.js";

const hits = market.parseYahooSearch(
  JSON.stringify({
    quotes: [{ symbol: "AAA.WA", shortname: "Synthetic", quoteType: "EQUITY", exchange: "WSE" }],
  }),
);
describe("instrument search", () => {
  it("validates length and whitespace and folds Polish and German letters", () => {
    expect(cleanSearchQuery("  AAA\u0085WA  ")).toBe("AAA WA");
    expect(searchFold("Łódź Straße")).toBe("lodz strasse");
    expect(() => cleanSearchQuery(" ")).toThrow();
    expect(() => cleanSearchQuery("x".repeat(61))).toThrow();
  });
  it("matches hidden names only with explicit caller permission and remote aliases retain vault isolation", async () => {
    const v = vault({ holder: false });
    v.value(createProfile, { slug: "synthetic", name: "Synthetic", baseCurrency: "PLN" });
    const own = stock(v, "AAA", "PL0000000AAA", {
      name: "Hidden owner label",
      aliases: [{ namespace: "yahoo", value: "AAA.WA" }],
    });
    applyRaw(v, [raw.watchAdded(v, own)]);
    stock(v, "ZZZ", "PL0000000ZZZ", { aliases: [{ namespace: "yahoo", value: "ZZZ.WA" }] });
    const service = new InstrumentSearch(() => 0);
    const deps = {
      read: v.store.read.bind(v.store),
      asOf: "2026-10-31",
      nameMatch: () => false,
      sources: () => ({
        symbols: {
          async search() {
            return hits;
          },
        },
        close() {},
      }),
    };
    expect((await service.search(deps, "Hidden", { remote: false })).local).toHaveLength(0);
    expect((await service.search(deps, "AAA", { remote: false })).local[0]?.state).toBe("watched");
    const remote = await service.search(deps, "unmatched");
    expect(remote.local[0]?.instrument_id).toBe(own);
    expect(remote.remote).toHaveLength(0);
    const other = await service.search(
      {
        ...deps,
        sources: () => ({
          symbols: {
            async search() {
              return hits.map((h) => ({ ...h, yahooSymbol: "ZZZ.WA" }));
            },
          },
          close() {},
        }),
      },
      "new query",
    );
    expect(other.remote[0]?.instrument_id).toBe(null);
  });
  it("caches only wholly successful source sets, exact normalized sent-text keys and TTL/LRU", async () => {
    let calls = 0;
    let closes = 0;
    let now = 0;
    let fail = true;
    const service = new InstrumentSearch(() => now);
    const sources = () => ({
      symbols: {
        async search() {
          calls++;
          return hits;
        },
      },
      isin: {
        async lookup() {
          if (fail) throw new Error("synthetic");
          return hits;
        },
      },
      close() {
        closes++;
      },
    });
    await service.remoteHits("IE00SYNTH001", sources);
    await service.remoteHits("IE00SYNTH001", sources);
    expect(calls).toBe(2);
    fail = false;
    await service.remoteHits("IE00SYNTH001", sources);
    await service.remoteHits("  ie00synth001  ", sources);
    expect(calls).toBe(3);
    now = 600_000;
    await service.remoteHits("IE00SYNTH001", sources);
    expect(calls).toBe(4);
    for (let i = 0; i < 64; i++) await service.remoteHits(`query ${i}`, sources);
    await service.remoteHits("IE00SYNTH001", sources);
    expect(calls).toBe(69);
    expect(closes).toBe(calls);
  });
});
