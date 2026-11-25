// Net worth converted into the headline currency at NBP rates (owner decision 2026-11-09): every
// currency's own net worth stays as it is and is converted on top. Synthetic data only.

import { describe, expect, it } from "vitest";
import { D } from "../decimal.js";
import { builtinRegistry } from "./builtinModules.js";
import { convertedHero, convertedSeriesView, type RateAt } from "./converted.js";
import type { NetWorthBook } from "./networth.js";
import { completePoints, heroFacts, netWorthSummary, seriesView } from "./overview.js";
import type { BalanceSnapshot, NetWorthAccount } from "./valuation.js";

const types = builtinRegistry().accountTypes;
const account = (id: string, currency: string, type = "checking"): NetWorthAccount => ({
  id,
  type,
  currency,
  active: true,
  removedAt: null,
});
const snap = (date: string, amount: string): BalanceSnapshot => ({
  date,
  amount: D(amount),
  source: "csv",
});
const TODAY = "2026-11-09";

/** NBP-like USD rates; no EUR rate at all. */
const USD_RATES: [string, string][] = [
  ["2026-09-01", "3.70"],
  ["2026-11-02", "3.60"],
];
const rateAt: RateAt = (currency, on) => {
  if (currency !== "USD") return null;
  let hit: { rate: ReturnType<typeof D>; date: string } | null = null;
  for (const [date, rate] of USD_RATES) if (date <= on) hit = { rate: D(rate), date };
  return hit;
};

/** 50 000 zł moved from the PLN account into USD investments at the start of November. */
function book(withEur = false): NetWorthBook {
  const accounts = [account("pln", "PLN"), account("usd", "USD", "savings")];
  const balances = new Map<string, BalanceSnapshot[]>([
    ["pln", [snap("2026-09-30", "100000.00"), snap("2026-11-02", "50000.00")]],
    ["usd", [snap("2026-09-30", "0.00"), snap("2026-11-02", "13888.89")]],
  ]);
  if (withEur) {
    accounts.push(account("eur", "EUR", "savings"));
    balances.set("eur", [snap("2026-09-30", "1000.00")]);
  }
  return { accounts, balances, contributors: [], types, today: TODAY };
}

describe("convertedSeriesView", () => {
  const request = { currency: "PLN", granularity: "monthly", scope: "total" } as const;

  it("money that changes currency is no loss: the PLN line halves, the converted one holds", () => {
    const pln = seriesView(book(), request, "pl");
    expect(pln.points.map((p) => p.value.toString())).toEqual(["100000.00", "50000.00"]);
    const all = convertedSeriesView(book(), request, "pl", rateAt);
    expect(all.convertedFrom).toEqual(["USD"]);
    expect(all.currency).toBe("PLN");
    // 13 888.89 USD at 3.60 (the rate of 11-02) = 50 000.00 zł.
    expect(all.points.map((p) => [p.date, p.value.toString()])).toEqual([
      ["2026-09-30", "100000.00"],
      ["2026-11-02", "100000.00"],
    ]);
    expect(all.points[1]?.components.money?.toString()).toBe("100000.00");
    expect(all.completeFrom).toBeNull();
  });

  it("a non-zero amount before the currency's first rate is not a whole point", () => {
    const early: NetWorthBook = {
      ...book(),
      balances: new Map([
        ["pln", [snap("2026-08-15", "100000.00")]],
        ["usd", [snap("2026-08-15", "100.00")]],
      ]),
    };
    const view = convertedSeriesView(early, { ...request, granularity: "daily" }, "pl", rateAt);
    expect(view.points.map((p) => p.date)).toEqual(["2026-08-15"]);
    expect(view.completeFrom).toBe("2026-08-16");
    expect(completePoints(view)).toEqual([]);
  });

  it("a currency without any rate stays out; one currency alone is the plain series", () => {
    const view = convertedSeriesView(book(true), request, "pl", rateAt);
    expect(view.convertedFrom).toEqual(["USD"]);
    expect(view.points.at(-1)?.value.toString()).toBe("100000.00");
    const plnOnly: NetWorthBook = { ...book(), accounts: [account("pln", "PLN")] };
    const plain = convertedSeriesView(plnOnly, request, "pl", rateAt);
    expect(plain).toEqual(seriesView(plnOnly, request, "pl"));
    expect(plain.convertedFrom).toBeUndefined();
  });
});

describe("convertedHero", () => {
  it("adds every other currency at today's rate and lists the ones without a rate", () => {
    const b = book(true);
    const summary = netWorthSummary(b, "PLN");
    const facts = heroFacts(summary);
    expect(facts.net.toString()).toBe("50000.00");
    const c = convertedHero(b, summary, facts, rateAt, TODAY);
    expect(c?.net.toString()).toBe("100000.00");
    expect(c?.assets.toString()).toBe("100000.00");
    expect(c?.liquid.toString()).toBe("100000.00");
    expect(c?.rateDate).toBe("2026-11-02");
    expect(
      c?.parts.map((p) => [p.currency, p.amount.toString(), p.quote?.rate.toString()]),
    ).toEqual([
      ["EUR", "1000.00", undefined],
      ["USD", "13888.89", "3.60"],
    ]);
  });

  it("one currency only: nothing to convert", () => {
    const b: NetWorthBook = { ...book(), accounts: [account("pln", "PLN")] };
    const summary = netWorthSummary(b, "PLN");
    expect(convertedHero(b, summary, heroFacts(summary), rateAt, TODAY)).toBeNull();
  });
});
