import { market, toCurrency } from "@cashu/domain/investments";
import { expect, it } from "vitest";
import { vault } from "../commands/testing/fixtures.js";
import { addToWatchlist } from "../commands/watchlist.js";
import { runBackfill } from "./backfill.js";
import { findProxy } from "./inputs.js";
import {
  backfillDeps,
  benchClose,
  benchStrategy,
  FakePrices,
  household,
  USD,
} from "./testing/household.js";

it("rechecks reference-only status inside the queued currency write", async () => {
  const v = vault();
  household(v, "Queued");
  const cache = new market.InMemoryPriceCache(),
    prices = new FakePrices();
  prices.closes.set("REFL.L", benchClose);
  prices.quotes.set("REFL.L", USD);
  let writes = 0;
  try {
    await runBackfill({
      ...backfillDeps(v, cache, { strategy: benchStrategy("REFL.L"), prices }),
      async runWrite<T>(work: () => T) {
        writes++;
        if (writes === 2) {
          const proxy = findProxy(v.store.read.bind(v.store), "REFL.L");
          if (proxy === undefined) throw new Error("synthetic proxy missing");
          v.value(addToWatchlist, { target: { stored: proxy.id } });
        }
        return work();
      },
    });
    expect(writes).toBeGreaterThanOrEqual(2);
    expect(findProxy(v.store.read.bind(v.store), "REFL.L")?.currency).toBe(toCurrency("GBP"));
  } finally {
    v.store.close();
  }
});
