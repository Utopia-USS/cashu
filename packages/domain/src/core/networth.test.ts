// Net worth over a synthetic NetWorthBook. Translates the core net-worth tests of
// tests/test_ingestion.py and test_a_eur_profile_sees_its_own_net_worth (tests/test_profiles.py), plus
// the contributor rules of core/networth.py (precedence, balance source rank, removed accounts).

import { describe, expect, it } from "vitest";
import { D, type Decimal } from "../decimal.js";
import { builtinRegistry } from "./builtinModules.js";
import {
  componentLabels,
  componentOrder,
  contribution,
  liabilityComponents,
  type NetWorthBook,
  netWorth,
  netWorthBreakdown,
  netWorthComponentSeries,
  netWorthSeries,
} from "./networth.js";
import {
  type BalanceSnapshot,
  ComputedValuation,
  type NetWorthAccount,
  type NetWorthContributor,
  RunningValuation,
  type Valuation,
} from "./valuation.js";

const types = builtinRegistry().accountTypes;
const TODAY = "2026-10-01";

function acc(id: string, type = "checking", extra: Partial<NetWorthAccount> = {}): NetWorthAccount {
  return { id, type, currency: "PLN", active: true, removedAt: null, ...extra };
}

function bal(date: string, amount: string, source = "open_banking"): BalanceSnapshot {
  return { date, amount: D(amount), source };
}

function book(
  accounts: NetWorthAccount[],
  balances: Record<string, BalanceSnapshot[]>,
  contributors: NetWorthContributor[] = [],
): NetWorthBook {
  return {
    accounts,
    balances: new Map(Object.entries(balances)),
    contributors,
    types,
    today: TODAY,
  };
}

/** A contributor that values fixed accounts (what a module's port does with its loaded rows). */
function fixed(values: Record<string, Valuation>): NetWorthContributor {
  return {
    valuations: (accounts) => new Map(Object.entries(values).filter(([id]) => accounts.has(id))),
  };
}

const str = (d: Decimal | null | undefined) => (d == null ? d : d.toString());

describe("net worth now", () => {
  // test_net_worth_uses_balances
  it("net worth uses balances", () => {
    const b = book([acc("a")], { a: [bal("2024-03-01", "1234.56")] });
    const { totals, lines } = netWorth(b);
    expect(str(totals.get("PLN"))).toBe("1234.56");
    expect(str(lines[0]?.amount)).toBe("1234.56");
    expect(lines[0]?.asOf).toBe("2024-03-01");
  });

  // test_credit_card_limit_not_counted_debt_is
  it("credit card limit not counted, debt is", () => {
    const b = book([acc("chk"), acc("limit", "credit"), acc("drawn", "credit")], {
      chk: [bal("2026-07-01", "5000.00")],
      limit: [bal("2026-07-01", "1000.00")], // available credit -> contributes 0
      drawn: [bal("2026-07-01", "-300.00")], // money owed -> subtracts
    });
    const { totals, lines } = netWorth(b);
    expect(str(totals.get("PLN"))).toBe("4700.00"); // 5000 - 300 debt; limit ignored
    const byId = new Map(lines.map((l) => [l.account.id, l]));
    expect(byId.get("limit")?.contribution?.eq(D("0"))).toBe(true);
    expect(str(byId.get("drawn")?.contribution)).toBe("-300.00");
    expect(byId.get("drawn")?.isLiability).toBe(true);
  });

  // test_net_worth_breakdown_with_property_and_mortgage
  it("net worth breakdown with property and mortgage", () => {
    const b = book([acc("chk"), acc("flat", "property"), acc("mort", "mortgage")], {
      chk: [bal("2026-07-01", "5000.00")],
      flat: [bal("2026-07-01", "850000.00", "manual")],
      mort: [bal("2026-07-01", "420000.00", "manual")],
    });
    const bd = netWorthBreakdown(b, "PLN");
    expect(str(bd.assets)).toBe("855000.00");
    expect(str(bd.liabilities)).toBe("420000.00");
    expect(str(bd.net)).toBe("435000.00");
    expect(str(bd.homeEquity)).toBe("430000.00");
    expect(Object.fromEntries([...bd.byType].map(([k, v]) => [k, v.toString()]))).toEqual({
      checking: "5000.00",
      property: "850000.00",
      mortgage: "-420000.00",
    });
  });

  // test_a_eur_profile_sees_its_own_net_worth (the net-worth half; the API picks the base currency)
  it("every currency keeps its own total", () => {
    const b = book([acc("eur", "checking", { currency: "EUR" }), acc("pln")], {
      eur: [bal("2026-09-30", "1200.00", "csv")],
      pln: [bal("2026-09-30", "300.00", "csv")],
    });
    const { totals } = netWorth(b);
    expect(Object.fromEntries([...totals].map(([c, v]) => [c, v.toString()]))).toEqual({
      EUR: "1200.00",
      PLN: "300.00",
    });
    expect(str(netWorthBreakdown(b, "EUR").net)).toBe("1200.00");
    expect(netWorthSeries(b, "EUR").at(-1)?.[1].toString()).toBe("1200.00");
    expect(netWorthSeries(b, "PLN").at(-1)?.[1].toString()).toBe("300.00");
  });

  it("totals start at 0.00, so they keep two places", () => {
    const b = book([acc("a")], { a: [bal("2026-01-01", "5")] });
    expect(str(netWorth(b).totals.get("PLN"))).toBe("5.00");
  });

  it("an account without data has a line but no total", () => {
    const { totals, lines } = netWorth(book([acc("empty")], {}));
    expect(totals.size).toBe(0);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.amount).toBeNull();
    expect(lines[0]?.contribution).toBeNull();
    expect(lines[0]?.asOf).toBeNull();
  });

  it("inactive accounts have no line; removed ones are never counted", () => {
    const b = book(
      [
        acc("on"),
        acc("off", "checking", { active: false }),
        acc("gone", "checking", { removedAt: "2026-05-01" }),
      ],
      {
        on: [bal("2026-01-01", "10.00")],
        off: [bal("2026-01-01", "20.00")],
        gone: [bal("2026-01-01", "40.00")],
      },
    );
    const { totals, lines } = netWorth(b);
    expect(lines.map((l) => l.account.id)).toEqual(["on"]);
    expect(str(totals.get("PLN"))).toBe("10.00");
    // The history counts inactive accounts (as Python does), never removed ones.
    expect(netWorthSeries(b, "PLN").at(-1)?.[1].toString()).toBe("30.00");
  });

  it("net worth as of a date cuts balance snapshots off; now does not", () => {
    const b = book([acc("a")], { a: [bal("2026-01-01", "10.00"), bal("2026-12-01", "99.00")] });
    expect(str(netWorth(b).totals.get("PLN"))).toBe("99.00"); // future-dated snapshot counts now
    expect(str(netWorth(b, "2026-06-30").totals.get("PLN"))).toBe("10.00");
    expect(netWorth(b, "2025-12-31").lines[0]?.amount).toBeNull();
  });

  it("open banking wins over csv and manual on the same date", () => {
    const b = book([acc("a")], {
      a: [
        bal("2026-07-01", "1.00", "manual"),
        bal("2026-07-01", "2.00", "csv"),
        bal("2026-07-01", "3.00"),
      ],
    });
    expect(str(netWorth(b).lines[0]?.amount)).toBe("3.00");
    // A later date wins whatever its source.
    const later = book([acc("a")], {
      a: [bal("2026-07-01", "3.00"), bal("2026-07-02", "4.00", "manual")],
    });
    expect(str(netWorth(later).lines[0]?.amount)).toBe("4.00");
  });

  it("the first contributor wins and balances fill the rest", () => {
    const loanValue = new ComputedValuation(() => D("900.00"));
    const other = new ComputedValuation(() => D("1.00"));
    const b = book(
      [acc("loan", "loan"), acc("chk")],
      { loan: [bal("2026-01-01", "5000.00")], chk: [bal("2026-01-01", "100.00")] },
      [fixed({ loan: loanValue }), fixed({ loan: other })],
    );
    const { totals, lines } = netWorth(b);
    const loan = lines.find((l) => l.account.id === "loan");
    expect(str(loan?.amount)).toBe("900.00");
    expect(loan?.asOf).toBe(TODAY); // computed values are "now" = today
    expect(str(loan?.contribution)).toBe("-900.00");
    expect(str(totals.get("PLN"))).toBe("-800.00");
  });

  it("a computed value is evaluated at the date asked", () => {
    const seen: string[] = [];
    const v = new ComputedValuation((d) => {
      seen.push(d);
      return D("7.00");
    });
    const b = book([acc("car", "vehicle")], {}, [fixed({ car: v })]);
    netWorth(b, "2025-10-01");
    expect(seen).toEqual(["2025-10-01"]);
  });

  it("the cash pool is 0 before its first movement", () => {
    const pool = new RunningValuation([["2026-05-01", D("50.00")]]);
    const b = book([acc("cash", "cash")], {}, [fixed({ cash: pool })]);
    expect(str(netWorth(b, "2026-04-30").totals.get("PLN"))).toBe("0.00");
    expect(str(netWorth(b).totals.get("PLN"))).toBe("50.00");
    expect(pool.at("2026-04-30")).toBeNull(); // no history point before it
  });

  it("liabilities subtract their magnitude whatever their stored sign", () => {
    expect(str(contribution(types, acc("m", "mortgage"), D("-100.00")))).toBe("-100.00");
    expect(str(contribution(types, acc("m", "mortgage"), D("100.00")))).toBe("-100.00");
    expect(contribution(types, acc("m", "mortgage"), null)).toBeNull();
  });
});

describe("components", () => {
  it("component order, liabilities and labels come from the registry", () => {
    expect(componentOrder(types)).toEqual([
      "money",
      "investments",
      "property",
      "vehicle",
      "mortgage",
      "loan",
    ]);
    expect(liabilityComponents(types)).toEqual(new Set(["loan", "mortgage"]));
    expect(componentLabels(types, "pl").get("vehicle")).toBe("Auto");
    expect(componentLabels(types, "en").get("vehicle")).toBe("Car");
  });
});

describe("history", () => {
  // test_net_worth_series_monthly_smoothing
  it("net worth series monthly smoothing", () => {
    const b = book([acc("a")], {
      a: [bal("2026-01-10", "100"), bal("2026-01-20", "150"), bal("2026-02-05", "200")],
    });
    const monthly = netWorthSeries(b, "PLN", "monthly");
    expect(monthly.map(([, v]) => v.toString())).toEqual(["150.00", "200.00"]); // period-end per month
    expect(netWorthSeries(b, "PLN", "daily")).toHaveLength(3);
  });

  it("weekly keeps the last point of each ISO week", () => {
    const b = book([acc("a")], {
      a: [bal("2026-01-05", "1"), bal("2026-01-11", "2"), bal("2026-01-12", "3")], // Mon, Sun, Mon
    });
    expect(netWorthSeries(b, "PLN", "weekly").map(([d]) => d)).toEqual([
      "2026-01-11",
      "2026-01-12",
    ]);
  });

  it("components stack by bucket and computed values sit on the axis of the others", () => {
    const car = new ComputedValuation((d) => (d < "2026-02-01" ? D("100.00") : D("90.00")));
    const b = book(
      [acc("chk"), acc("car", "vehicle"), acc("mort", "mortgage")],
      {
        chk: [bal("2026-01-15", "10.00"), bal("2026-02-15", "20.00")],
        mort: [bal("2026-01-15", "50.00", "manual")],
      },
      [fixed({ car })],
    );
    const series = netWorthComponentSeries(b, "PLN");
    expect(series.map(([d]) => d)).toEqual(["2026-01-15", "2026-02-15"]);
    const last = series[1]?.[1];
    expect(last && Object.fromEntries([...last].map(([k, v]) => [k, v.toString()]))).toEqual({
      money: "20.00",
      vehicle: "90.00",
      mortgage: "-50.00",
    });
    expect(netWorthSeries(b, "PLN").map(([, v]) => v.toString())).toEqual(["60.00", "60.00"]);
    // liquid: only liquid account types
    expect(netWorthSeries(b, "PLN", "daily", "liquid").map(([, v]) => v.toString())).toEqual([
      "10.00",
      "20.00",
    ]);
    expect(netWorthComponentSeries(b, "EUR")).toEqual([]);
  });
});
