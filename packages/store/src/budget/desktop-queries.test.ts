import { D } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { createProfile } from "../core/commands.js";
import { runQuery, watchQuery } from "../query.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { importStatement, setCushion, setTransactionCategory } from "./commands.js";
import { setDesktopMerchantCategory } from "./desktop-commands.js";
import { budgetDesktopQueries } from "./desktop-queries.js";

function fixture(modules = ["budget"]) {
  const store = openTestStore(),
    env = testEnv();
  run(store, env, createProfile, {
    slug: "synthetic-budget-ui",
    name: "Synthetic",
    baseCurrency: "PLN",
    modules,
  });
  const seed = (
    currency: string,
    rows: { date: string; amount: string; name: string; ref: string }[],
  ) => {
    const result = run(store, env, importStatement, {
      statement: {
        bank: "mbank",
        accountNumber: null,
        accountName: `Synthetic ${currency}`,
        currency,
        balances: [],
        closingBalances: [],
        transactions: rows.map((row) => ({
          bookingDate: row.date,
          valueDate: null,
          amount: D(row.amount),
          currency,
          counterpartyName: row.name,
          counterpartyIban: null,
          description: row.ref,
          reference: row.ref,
          bankTransactionId: null,
          source: "csv" as const,
          raw: {},
        })),
      },
      newestDayRule: false,
    });
    if (!result.ok) throw new Error("synthetic import refused");
    return result.value.account;
  };
  return { store, env, seed };
}
const queries = budgetDesktopQueries();

describe("native budget desktop adapters", () => {
  it("preserves the default closed month with data, currency separation and optional plan authority", () => {
    const f = fixture(["budget", "investments"]);
    try {
      f.seed("PLN", [
        { date: "2026-02-01", amount: "100", name: "Synthetic payroll", ref: "income" },
      ]);
      f.seed("EUR", [{ date: "2026-02-02", amount: "-10", name: "Synthetic shop", ref: "shop" }]);
      const result = runQuery(f.store, queries.monthClose, {
        today: "2026-10-01",
        month: null,
        lang: "en",
      }).value;
      expect(result.strategyUnavailable).toBe(true);
      expect(result.close?.month).toBe("2026-02");
      expect(result.close?.currencies.map((row) => [row.currency, row.surplus.toString()])).toEqual(
        [
          ["PLN", "100.00"],
          ["EUR", "-10.00"],
        ],
      );
      expect(() =>
        runQuery(f.store, queries.monthClose, {
          today: "2026-10-01",
          month: "2026-13",
          lang: "en",
        }),
      ).toThrow("invalid budget month");
      let calls = 0;
      const other = fixture();
      try {
        runQuery(
          other.store,
          budgetDesktopQueries({
            plannedContribution: () => {
              calls++;
              return null;
            },
          }).monthClose,
          { today: "2026-10-01", month: null, lang: "en" },
        );
        expect(calls).toBe(0);
      } finally {
        other.store.close();
      }
    } finally {
      f.store.close();
    }
  });
  it("keeps merchant updates live, counts eligible rows independently of rule changes and preserves individual decisions", () => {
    const f = fixture();
    let stop: (() => void) | undefined;
    try {
      f.seed("PLN", [
        { date: "2026-02-01", amount: "-10", name: "Synthetic MZX", ref: "one" },
        { date: "2026-02-02", amount: "-10", name: "Synthetic MZX", ref: "two" },
      ]);
      const rows = runQuery(f.store, queries.uncategorized, { currency: "PLN" }).value;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.total.eq(D("20.00"))).toBe(true);
      expect(runQuery(f.store, queries.uncategorized, { currency: "EUR" }).value).toEqual([]);
      const key = rows[0]?.merchantKey ?? "";
      const drill = runQuery(f.store, queries.drill, {
        currency: "PLN",
        category: "other",
        period: {},
        sort: "date",
        order: "asc",
      }).value;
      expect(drill.map((row) => row.date)).toEqual(["2026-02-01", "2026-02-02"]);
      run(f.store, f.env, setTransactionCategory, { txn: drill[0]?.key, category: "transport" });
      const snapshots: number[] = [];
      stop = watchQuery(
        f.store,
        queries.uncategorized,
        { currency: "PLN" },
        {
          onValue: (value) => snapshots.push(value.length),
          onError: (error) => {
            throw error;
          },
        },
      );
      for (let i = 0; i < 2; i++) {
        const outcome = run(f.store, f.env, setDesktopMerchantCategory, {
          merchantKey: key,
          category: "groceries",
        });
        expect(outcome.ok && outcome.value.updated).toBe(i === 0 ? 1 : 0);
      }
      expect(snapshots.at(-1)).toBe(0);
      expect(
        runQuery(f.store, queries.drill, {
          currency: "PLN",
          category: "transport",
          period: {},
          sort: "date",
          order: "desc",
        }).value,
      ).toHaveLength(1);
      expect(
        run(f.store, f.env, setDesktopMerchantCategory, { merchantKey: key, category: "nonsense" })
          .ok,
      ).toBe(false);
    } finally {
      stop?.();
      f.store.close();
    }
  });
  it("shows independent month facts when legacy settings cannot be represented", () => {
    const f = fixture();
    try {
      f.seed("PLN", [
        { date: "2026-02-01", amount: "100", name: "Synthetic payroll", ref: "income" },
      ]);
      run(f.store, f.env, setCushion, { enabled: false, accounts: [] });
      // Synthetic legacy copied view row: no valid native account-gid array. CLI semantics stay null.
      f.store.driver.prepare("UPDATE budget_settings SET accounts = ?").run("[42]");
      const result = runQuery(f.store, queries.monthClose, {
        today: "2026-10-01",
        month: null,
        lang: "en",
      }).value;
      expect(result.settingsUnavailable).toBe(true);
      expect(result.close.currencies[0]?.income.toString()).toBe("100.00");
      expect(result.close.currencies[0]?.cushionTopUp).toBeNull();
      expect(result.close.currencies[0]?.suggestedTransfer).toBeNull();
      expect(runQuery(f.store, queries.settings, undefined).value.settings).toBeNull();
    } finally {
      f.store.close();
    }
  });
  it("retains stale subscriptions, uses booking reference for active status and isolates vaults", () => {
    const a = fixture(),
      b = fixture();
    try {
      a.seed(
        "PLN",
        [1, 2, 3, 4].map((month) => ({
          date: `2025-${String(month).padStart(2, "0")}-01`,
          amount: "-20",
          name: "Synthetic recurring",
          ref: "service",
        })),
      );
      expect(
        runQuery(a.store, queries.subscriptions, undefined).value.some((row) => row.active),
      ).toBe(true);
      a.seed("PLN", [
        { date: "2026-10-01", amount: "100", name: "Synthetic latest", ref: "latest" },
      ]);
      const rows = runQuery(a.store, queries.subscriptions, undefined).value;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => !row.active)).toBe(true);
      expect(runQuery(b.store, queries.subscriptions, undefined).value).toEqual([]);
    } finally {
      a.store.close();
      b.store.close();
    }
  });
  it("keeps cushion validation and account ownership at the command boundary", () => {
    const f = fixture();
    try {
      const account = f.seed("EUR", []);
      expect(
        run(f.store, f.env, setCushion, {
          enabled: true,
          targetAmount: "100",
          currency: "PLN",
          accounts: [account],
        }).ok,
      ).toBe(false);
      expect(
        run(f.store, f.env, setCushion, { enabled: true, targetMonths: 37, accounts: [] }).ok,
      ).toBe(false);
      expect(
        run(f.store, f.env, setCushion, {
          enabled: true,
          targetAmount: "100",
          currency: "EUR",
          accounts: [account, account],
        }).ok,
      ).toBe(true);
      expect(
        runQuery(f.store, queries.settings, undefined).value.settings?.cushion.accountIds,
      ).toEqual([account]);
    } finally {
      f.store.close();
    }
  });
});
