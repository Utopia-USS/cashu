/** Portfolio read projections over a small hand-computable household (store loading has its own tests). */
import { describe, expect, it } from "vitest";
import { parseDateTime } from "../../dates.js";
import { AccountWrapper, AssetClass, TxnType } from "../domain/index.js";
import { asProfileId, type Currency } from "../domain/values.js";
import { annotateSubjects } from "../plan/annotations.js";
import { buildSnapshot, InMemoryFxLookup, valuePortfolio } from "../portfolio/index.js";
import {
  acc,
  bar,
  buildTxn,
  buy,
  cashTxn,
  EUR,
  fxRate,
  instrument,
  marketView,
  PLN,
  USD,
} from "../portfolio/testing/fixtures.js";
import { instrument as fixtureInstrument } from "../rules/testing/fixtures.js";
import { accountsView } from "./accounts.js";
import { allocationView } from "./allocation.js";
import { overviewView } from "./overview.js";
import { positionChartView } from "./positionChart.js";
import { positionDetailView } from "./positionDetail.js";
import { instrumentView, positionsView } from "./positions.js";
import type {
  BrokerageAccountFact,
  PortfolioProjectionInput,
  PortfolioViewState,
  ViewFacts,
} from "./types.js";
import { watchlistView } from "./watchlist.js";

const AS_OF = "2026-03-31";
const AAA = instrument("aaa", { name: "Alpha", symbol: "AAA", currency: PLN });
const USX = instrument("usx", { name: "Usonia", symbol: "USX", currency: USD });
const EUX = instrument("eux", { name: "Euria", symbol: "EUX", currency: EUR });
const BND = instrument("bnd", {
  name: "Bond",
  symbol: "BND",
  currency: PLN,
  assetClass: AssetClass.BOND,
});
const account = (id: string, name: string): BrokerageAccountFact => ({
  id: acc(id),
  name,
  broker: "xtb",
  brokerName: "XTB",
  wrapper: AccountWrapper.REGULAR,
  currency: PLN,
  importer: null,
  hasMapping: false,
  active: true,
  snapshotDate: null,
  lastImport: null,
});
const dividend = (accountId: string, amount: string, currency: Currency) =>
  buildTxn(accountId, "aaa", {
    type: TxnType.DIVIDEND,
    tradeDate: "2026-03-10",
    quantity: null,
    price: null,
    currency,
    grossAmount: amount,
    cashAmount: amount,
  });
const TXNS = [
  cashTxn("A", "2026-01-02", "5000"),
  cashTxn("B", "2026-01-02", "1000"),
  buy("A", "aaa", "2026-01-05", "10", "100"),
  buy("B", "aaa", "2026-01-06", "5", "120"),
  buy("A", "usx", "2026-01-05", "2", "50", { currency: USD }),
  buy("A", "eux", "2026-01-05", "1", "10", { currency: EUR }),
  buy("B", "bnd", "2026-01-07", "4", "100"),
  dividend("A", "20", PLN),
  dividend("B", "3", USD),
];
const BARS = [
  bar("aaa", "2026-03-30", "140"),
  bar("aaa", AS_OF, "150"),
  bar("usx", AS_OF, "60"),
  bar("eux", AS_OF, "12"),
  bar("bnd", AS_OF, "100"),
];
const RATES = [fxRate(USD, "2026-01-05", "4"), fxRate(USD, AS_OF, "4")];
const WWW = instrument("www", { name: "Watched", symbol: "WWW", currency: PLN });
const WATCHED_BARS = [
  bar("www", "2026-03-20", "50"),
  bar("www", "2026-03-24", "40"),
  bar("www", "2026-03-25", "45"),
];
const CLOCK = { now: parseDateTime(`${AS_OF}T12:00:00Z`), today: AS_OF, timeZone: "Europe/Warsaw" };

function state(accountIds: readonly string[] | null = null): PortfolioViewState {
  const vault = asProfileId("0b7e2c4d9a1f43e8b6c5d7e8f9a0b1c2");
  const instruments = [AAA, USX, EUX, BND, WWW];
  const snapshot = buildSnapshot(vault, TXNS, AS_OF);
  const market = marketView(AS_OF, { instruments, bars: BARS });
  const filter = accountIds === null ? null : accountIds.map(acc);
  const valued = valuePortfolio(snapshot, market, new InMemoryFxLookup(RATES), PLN, 5, {
    accountIds: filter === null ? null : new Set(filter),
  });
  return {
    vault,
    asOf: AS_OF,
    base: PLN,
    accounts: [account("A", "Main"), account("B", "Spare")],
    accountFilter: filter,
    txns: TXNS,
    snapshot,
    market,
    historyBars: new Map([...market.bars, [WWW.id, WATCHED_BARS]]),
    instruments: new Map(instruments.map((i) => [i.id, i])),
    valued,
    allocation: null,
    config: null,
  };
}
const FACTS: ViewFacts = {
  clock: CLOCK,
  subjects: [],
  signals: [],
  alerts: [],
  watched: [],
  unread: new Map(),
  lastRun: null,
  lastGoodRunId: null,
};
function input(
  s: PortfolioViewState = state(),
  facts: ViewFacts = FACTS,
): PortfolioProjectionInput {
  return {
    state: s,
    facts,
    options: { lang: "en", forOwner: true, accounts: null },
    annotations: annotateSubjects(facts.subjects, facts.clock, "en"),
  };
}
/** Exact decimals of the view as plain numbers (every amount here is hand-computable). */
const num = (value: { toString(): string } | null | undefined) =>
  value === null || value === undefined ? null : Number(value.toString());

describe("positions", () => {
  it("groups accounts per instrument, sorts by value and never sums dividend currencies", () => {
    const view = positionsView(input());
    expect(view.positions.map((p) => [p.instrument.id, num(p.value)])).toEqual([
      ["aaa", 2250],
      ["usx", 480],
      ["bnd", 400],
      ["eux", null],
    ]);
    const [aaa, usx] = view.positions;
    expect([aaa?.quantity, aaa?.cost, aaa?.unrealized].map(num)).toEqual([15, 1600, 650]);
    expect(aaa?.unrealized_pct).toBe(0.40625);
    expect(aaa?.accounts.map((a) => [a.account_id, num(a.value), a.unrealized_pct])).toEqual([
      ["A", 1500, 0.5],
      ["B", 750, 0.25],
    ]);
    expect([...(aaa?.dividends ?? [])].map(([c, v]) => [c, num(v)])).toEqual([
      ["PLN", 20],
      ["USD", 3],
    ]);
    // A lot's result is in its own currency (USD), not converted.
    expect(usx?.lots.map((l) => [l.currency, num(l.result)])).toEqual([["USD", 20]]);
    expect(num(view.total)).toBe(7162);
  });

  it("leaves a holding without an FX rate unvalued instead of counting it as zero", () => {
    const eux = positionsView(input()).positions.find((p) => p.instrument.id === "eux");
    expect(eux).toMatchObject({ missing_fx_currency: "EUR", value: null, weight: null });
    expect(eux?.unrealized).toBeNull();
    expect(eux?.unrealized_pct).toBeNull();
  });

  it("an account filter scopes holdings and dividends", () => {
    const aaa = positionsView(input(state(["A"]))).positions[0];
    expect(aaa?.accounts.map((a) => a.account_id)).toEqual(["A"]);
    expect([...(aaa?.dividends ?? [])].map(([c, v]) => [c, num(v)])).toEqual([["PLN", 20]]);
  });
});

describe("allocation and accounts", () => {
  it("shares by asset class include cash and stay without buckets when there is no strategy", () => {
    const view = allocationView(input());
    expect(view.by_asset_class.map((r) => [r.key, num(r.value), r.weight])).toEqual([
      ["cash", 4032, 0.562971],
      ["equity", 2730, 0.381178],
      ["bond", 400, 0.05585],
    ]);
    expect(view).toMatchObject({
      has_strategy: false,
      buckets: [],
      unclassified: null,
      band: null,
    });
  });

  it("values accounts with their cash and hides out-of-scope accounts", () => {
    const all = accountsView(state().accounts, state());
    expect(all.map((a) => [a.id, num(a.value), a.share])).toEqual([
      ["A", 6000, 0.837755],
      ["B", 1162, 0.162245],
    ]);
    const scoped = accountsView(state().accounts, state(["A"]));
    expect(scoped.map((a) => [a.id, num(a.value)])).toEqual([
      ["A", 6000],
      ["B", null],
    ]);
    expect(accountsView(state().accounts, null).map((a) => a.value)).toEqual([null, null]);
  });
});

describe("overview", () => {
  it("computes unrealized only over holdings with both value and cost, and lists missing FX", () => {
    const view = overviewView({
      ...input(),
      strategyStatus: {
        config: null,
        errors: [],
        warnings: [],
      } as unknown as Parameters<typeof overviewView>[0]["strategyStatus"],
      newestRateDate: AS_OF,
      newestBarDate: AS_OF,
    });
    expect([view.kpis.unrealized.amount, view.kpis.unrealized.cost].map(num)).toEqual([730, 2400]);
    expect(view.kpis.cash.weight).toBe(0.562971);
    expect(view.freshness.fx.missing).toEqual(["EUR"]);
  });
});

describe("chart and detail", () => {
  const sparse = [bar("aaa", "2023-01-02", "9"), bar("aaa", "2023-06-01", "7")];
  it("the chart keeps the 52-week high and last close from full history beyond the drawn window", () => {
    const chart = positionChartView({ ...input(), instrument: AAA, bars: sparse });
    expect(chart.series).toEqual([]);
    expect(num(chart.high_52w)).toBe(9);
    expect(chart.last).toMatchObject({ date: "2023-06-01" });
    expect(num(chart.cost?.average)).toBeCloseTo(1600 / 15, 9);
  });

  it("the detail high comes only from its own clipped series", () => {
    const detail = positionDetailView({
      ...input(),
      instrument: AAA,
      detailBars: [],
      chartBars: sparse,
      history: { theses: [], decisions: [], manualValuations: [] },
    });
    expect(detail.high_52w).toBeNull();
    expect(detail.entry.state).toBe("held");
    expect(detail.transactions.map((t) => t.type)).toEqual(["buy", "buy", "dividend", "dividend"]);
  });
});

describe("watchlist", () => {
  const watch = {
    id: "w1",
    instrumentId: WWW.id,
    note: null,
    tags: [],
    source: "owner",
    addedAt: CLOCK.now,
  };
  const alert = (id: string, kind: string, level: number) => ({
    id,
    instrumentId: WWW.id,
    kind,
    params: { level },
    title: id,
    source: "owner",
    status: "active" as const,
    severity: "info" as const,
    polarity: "neutral" as const,
    lastTriggeredAt: null,
    expiresAt: null,
    snoozedUntil: null,
    createdAt: CLOCK.now,
    updatedAt: CLOCK.now,
  });
  it("shows day change, distance from the 52-week high, staleness and the nearest live alert", () => {
    const [row] = watchlistView(
      input(state(), {
        ...FACTS,
        watched: [watch],
        alerts: [alert("far", "price_above", 54), alert("near", "price_below", 40.5)],
      }),
    );
    expect(row?.held).toBe(false);
    expect(row?.price).toMatchObject({ change_1d: 0.125, from_high_52w: -0.1, stale: true });
    expect(num(row?.price?.high_52w)).toBe(50);
    expect(row?.alerts.nearest).toMatchObject({ alert_id: "near", distance_pct: -0.1 });
  });
});

describe("instrumentView strength", () => {
  it("carries the strength fields independent of the plan; null strength hides basis and reason", () => {
    const base = fixtureInstrument("held");
    const strong = instrumentView(
      {
        ...base,
        positionStrength: "strong",
        strengthBasis: "on_track",
        strengthReason: "Teza na dobrej drodze",
        strengthAt: parseDateTime("2026-10-30T12:00:00Z"),
      },
      true,
    );
    expect(strong).toMatchObject({
      plan: null,
      strength: "strong",
      strength_basis: "on_track",
      strength_reason: "Teza na dobrej drodze",
      strength_at: "2026-10-30T12:00:00+00:00",
    });
    expect(
      instrumentView({ ...base, strengthBasis: "on_track", strengthReason: "stale" }, false),
    ).toMatchObject({
      strength: null,
      strength_basis: null,
      strength_reason: null,
      strength_at: null,
    });
  });
});
