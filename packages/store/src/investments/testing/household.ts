/** Synthetic event-backed household for native investment read-service acceptance. */
import { D, type IsoDate, parseDateTime, toCurrency } from "@cashu/domain";
import { asProfileId, market } from "@cashu/domain/investments";
import { loadStrategy } from "@cashu/domain/investments/strategy";
import { TEST_VAULT } from "../../testing/store.js";
import type { StrategyState } from "../services/strategy.js";
import { account, claim, det, Events, instrument, ulid } from "./kit.js";

export const HOUSEHOLD_NOW = "2026-10-31T12:00:00.123456Z";
export function cachedClose(date: IsoDate, close: string, currency = "PLN"): market.CachedBar {
  return {
    date,
    close: D(close),
    currency: toCurrency(currency),
    open: null,
    high: null,
    low: null,
    volume: null,
    fetchedAt: null,
  };
}
export function household() {
  const ev = new Events();
  const first = instrument(ev, ["isin", "PL0000000101"], {
    symbol: "AAA",
    mic: "XWAR",
    name: "Synthetic Alpha",
  });
  const watched = instrument(ev, ["isin", "PL0000000102"], {
    symbol: "BBB",
    mic: "XWAR",
    name: "Synthetic Beta",
  });
  const saved = instrument(ev, ["isin", "PL0000000103"], {
    symbol: "CCC",
    mic: "XWAR",
    name: "Synthetic Gamma",
  });
  const accountA = ulid(101);
  const accountB = ulid(102);
  const watch = det("watchlist_items", watched.gid);
  const removedWatch = det("watchlist_items", saved.gid);
  const result = loadStrategy(`version: 1
base_currency: PLN
buckets:
  - id: stocks
    match: {asset_class: equity}
  - id: cash
    match: {asset_class: cash}
allocation:
  targets: {stocks: 0.8, cash: 0.2}
rules: []
`);
  if (result.config === null) throw new Error("synthetic strategy did not parse");
  const strategy: StrategyState = {
    state: "valid",
    result,
    config: result.config,
    issues: result.issues,
    inactiveRules: result.inactiveRules,
    sha256: null,
    version: null,
    changed: false,
    readError: null,
  };
  const events = [
    ev.make("profile.created", TEST_VAULT, {
      slug: "synthetic",
      name: "Synthetic household",
      baseCurrency: "PLN",
      mcpPrivacy: "strict",
    }),
    account(ev, accountA),
    account(ev, accountB),
    ...first.events,
    ...watched.events,
    ...saved.events,
    claim(ev, first.gid, ["yahoo", "AAA.WA"]),
    claim(ev, watched.gid, ["yahoo", "BBB.WA"]),
    ev.make("invTxn.imported", det("inv_transactions", accountA, "1".repeat(64)), {
      account: accountA,
      dedupHash: "1".repeat(64),
      type: "deposit",
      instrument: null,
      quantity: null,
      price: null,
      tradeDate: "2026-09-30",
      grossAmount: "100",
      cashAmount: "100",
    }),
    ev.make("invTxn.imported", det("inv_transactions", accountA, "2".repeat(64)), {
      account: accountA,
      dedupHash: "2".repeat(64),
      instrument: first.gid,
      quantity: "2",
      price: "10",
      tradeDate: "2026-10-01",
      grossAmount: "20",
      cashAmount: "-20",
    }),
    ev.make("invTxn.imported", det("inv_transactions", accountB, "3".repeat(64)), {
      account: accountB,
      dedupHash: "3".repeat(64),
      instrument: first.gid,
      quantity: "1",
      price: "10",
      tradeDate: "2026-10-01",
      grossAmount: "10",
      cashAmount: "-10",
    }),
    ev.make("invTxn.imported", det("inv_transactions", accountA, "4".repeat(64)), {
      account: accountA,
      dedupHash: "4".repeat(64),
      instrument: first.gid,
      quantity: "7",
      price: "10",
      tradeDate: "2026-11-10",
      grossAmount: "70",
      cashAmount: "-70",
    }),
    ev.make("watchlist.added", watch, {
      instrument: watched.gid,
      source: "user",
      note: null,
      tags: [],
    }),
    ev.make("watchlist.added", removedWatch, {
      instrument: saved.gid,
      source: "user",
      note: null,
      tags: [],
    }),
    ev.make("watchlist.removed", removedWatch),
    ...[first, watched, saved].map((inst) =>
      ev.make("instrumentOverride.planSet", det("inv_profile_instruments", inst.gid), {
        instrument: inst.gid,
        plan: "buy",
        reason: "Synthetic recommendation",
        stamps: { plan_at: "2026-10-01T12:00:00Z" },
      }),
    ),
  ];
  const prices = new market.InMemoryPriceCache();
  for (const symbol of ["AAA.WA", "BBB.WA"])
    prices.upsertBars(
      market.marketSymbol("yahoo", symbol),
      [cachedClose("2026-09-30", "10"), cachedClose("2026-10-31", "12")],
      parseDateTime(HOUSEHOLD_NOW),
    );
  return {
    ev,
    events,
    prices,
    strategy,
    vault: asProfileId(TEST_VAULT),
    accountA,
    accountB,
    first: first.gid,
    watched: watched.gid,
    saved: saved.gid,
    watch,
    removedWatch,
  };
}
