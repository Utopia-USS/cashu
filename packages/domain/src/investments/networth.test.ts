// The brokerage net-worth contributor on synthetic rows (hand-computed numbers).

import { describe, expect, it } from "vitest";
import {
  builtinRegistry,
  type NetWorthAccount,
  netWorth,
  orderContributors,
} from "../core/index.js";
import { asProfileId, Currencies } from "./domain/values.js";
import { BrokerageContributor, type BrokerageHistory, monthEnds } from "./networth.js";
import {
  bar,
  buildTxn,
  buy,
  cashTxn,
  fxRate,
  instrument,
  USD,
} from "./portfolio/testing/fixtures.js";

const TODAY = "2026-03-31";
const ABC = instrument("abc", { symbol: "ABC" });
const XMPL = instrument("xmpl", { symbol: "XMPL", currency: USD, mic: "XNAS" });

function history(account: string): BrokerageHistory {
  return {
    profileId: asProfileId("p"),
    txns: [
      cashTxn(account, "2026-01-05", "20000"),
      buy(account, "abc", "2026-01-10", "100", "50"),
      buildTxn(account, "xmpl", {
        tradeDate: "2026-02-10",
        quantity: "20",
        price: "100",
        currency: USD,
        cashAmount: "-8000",
        cashCurrency: Currencies.PLN,
        fxRate: "4.0",
      }),
    ],
    renames: [],
    instruments: new Map([
      [ABC.id, ABC],
      [XMPL.id, XMPL],
    ]),
    manualValuations: [],
    bars: [bar("abc", "2026-03-30", "60"), bar("xmpl", "2026-03-30", "100")],
    rates: [fxRate(USD, "2026-02-09", "4.0"), fxRate(USD, "2026-03-30", "4.0")],
  };
}

const account = (id: string, currency = "PLN", type = "brokerage"): NetWorthAccount => ({
  id,
  type,
  currency,
  active: true,
  removedAt: null,
});

function valuationOf(id: string, currency = "PLN") {
  const contributor = new BrokerageContributor(history(id), TODAY);
  const found = contributor.valuations(new Map([[id, account(id, currency)]])).get(id);
  if (found === undefined) throw new Error("no valuation");
  return found;
}

describe("brokerage net-worth contributor", () => {
  it("values holdings and broker cash in the account currency", () => {
    // ABC 100 x 60 + XMPL 20 x 100 USD x 4.0 + cash 20000 - 5000 - 8000
    const entry = valuationOf("a1").latest(null, TODAY);
    expect(entry?.[0]).toBe(TODAY);
    expect(entry?.[1].toString()).toBe("21000.0");
    const registry = builtinRegistry();
    const book = {
      accounts: [account("a1")],
      balances: new Map(),
      contributors: orderContributors(registry, {
        investments: new BrokerageContributor(history("a1"), TODAY),
      }),
      types: registry.accountTypes,
      today: TODAY,
    };
    expect(
      Object.fromEntries([...netWorth(book).totals].map(([c, v]) => [c, v.toString()])),
    ).toEqual({ PLN: "21000.00" }); // core totals start from 0.00
  });

  it("values a past date from the transactions up to it; nothing before the first one", () => {
    const v = valuationOf("a1");
    expect(v.latest("2026-01-06", TODAY)?.[1].toString()).toBe("20000"); // only the deposit
    expect(v.latest("2026-01-01", TODAY)).toBeNull();
  });

  it("puts the history on month ends and today, held flat in between", () => {
    const v = valuationOf("a1");
    expect(v.axisDates()).toEqual(["2026-01-31", "2026-02-28", TODAY]);
    // 2026-02-15 -> the 2026-01-31 point: ABC at its last trade price 50 (no bar yet) + cash 15000
    expect(v.at("2026-02-15")?.toString()).toBe("20000");
    expect(v.at("2026-01-04")).toBeNull();
    expect(v.at(TODAY)?.toString()).toBe("21000.0");
  });

  it("values an account in another currency in that currency", () => {
    // PLN per USD 4.0 inverted to 0.2500000000: 6000 PLN + 7000 PLN cash, plus 2000 USD
    expect(valuationOf("a2", "USD").latest(null, TODAY)?.[1].toString()).toBe("5250.0000000000");
  });

  it("leaves accounts without investments transactions (and other types) to the core", () => {
    const contributor = new BrokerageContributor(history("a1"), TODAY);
    const found = contributor.valuations(
      new Map([
        ["a1", account("a1")],
        ["empty", account("empty")],
        ["checking", account("checking", "PLN", "checking")],
      ]),
    );
    expect([...found.keys()]).toEqual(["a1"]);
    expect(
      new BrokerageContributor({ ...history("a1"), txns: [] }, TODAY).valuations(
        new Map([["a1", account("a1")]]),
      ).size,
    ).toBe(0);
  });

  it("month ends from the start's month, before the end", () => {
    expect(monthEnds("2025-11-15", "2026-02-03")).toEqual([
      "2025-11-30",
      "2025-12-31",
      "2026-01-31",
    ]);
    expect(monthEnds("2026-01-01", "2026-01-31")).toEqual([]);
  });
});
