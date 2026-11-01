// Touched-table invalidation of the watchlist commands (testing.md: each command's touched tables
// re-run the queries that read them): the batch touches a table the query's SQL reads, a subscriber
// to that read set is notified once, and the answer changed. Synthetic data only.
import { describe, it } from "vitest";
import { watchlist, watchlistItem, watchRowFor } from "../queries/alerts.js";
import { vaultInstrumentGids } from "../queries/instruments.js";
import { storedByYahoo } from "../queries/watchlist.js";
import { stock, vault } from "./testing/fixtures.js";
import { expectInvalidates } from "./testing/invalidation.js";
import { addToWatchlist, removeFromWatchlist, updateWatchlistItem } from "./watchlist.js";

describe("watchlist command batches invalidate the queries that read their tables", () => {
  it("add, update, remove and restore", () => {
    const v = vault();
    const gid = stock(v, "WATCH", "PL0000000201");
    const added = expectInvalidates(v, addToWatchlist, { target: { stored: gid } }, watchlist);
    const item = added.ok ? (added.value as { item: string }).item : "";
    expectInvalidates(v, updateWatchlistItem, { item, note: "notatka" }, (r) =>
      watchlistItem(r, item),
    );
    expectInvalidates(v, removeFromWatchlist, { item }, watchlist);
    expectInvalidates(v, addToWatchlist, { target: { instrument: gid }, tags: ["t"] }, (r) =>
      watchRowFor(r, gid),
    );
  });

  it("an add that stores a planned instrument", () => {
    const v = vault();
    const planned = {
      name: "Nowa SA",
      currency: "PLN",
      assetClass: "equity",
      symbol: "NOWA",
      mic: "XWAR",
      aliases: [{ namespace: "yahoo", value: "NOWA.WA", guessed: true }],
    };
    const input = { target: { planned, yahooSymbol: "NOWA.WA" } };
    expectInvalidates(v, addToWatchlist, input, (r) => storedByYahoo(r, ["NOWA.WA"]));
    const other = {
      target: { planned: { ...planned, symbol: "INNA", aliases: [] }, yahooSymbol: "INNA.WA" },
    };
    expectInvalidates(v, addToWatchlist, other, vaultInstrumentGids);
  });
});
