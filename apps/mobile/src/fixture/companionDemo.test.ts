// The companion demo on the real store over better-sqlite3 (Node): both vaults build through the
// real commands, the engine derives what the companion screens need (uncategorized rows, llm rows,
// matched own transfers, the loan, assets, Open Banking freshness), and the build is deterministic.
import { budget, D, parseDateTime } from "@cashu/domain";
import {
  betterSqlite3Driver,
  builtinModules,
  investmentsQueries,
  investmentsResearch,
  Store,
} from "@cashu/store";
import { budgetScreenCashflow } from "@cashu/store/budget/screen";
import { SqlPriceCache } from "@cashu/store/investments/local";
import { runQuery } from "@cashu/store/query";
import { viewHash } from "@cashu/store/runtime";
import Database from "better-sqlite3";
import { phoneInvestmentSources } from "../services/investments";
import { createMoneyQueries } from "../services/moneyQueries";
import {
  buildCompanionVault,
  COMPANION_VAULTS,
  companionVaultComplete,
  seedCompanionDemoPrices,
} from "./companionDemo";

const TODAY = "2026-11-12";
const MONTH = TODAY.slice(0, 7);
/** One batch per account per month: 36 per account. */
const PER_ACCOUNT = { n: 36 };

function open(which: "anna" | "home", db = new Database(":memory:")): Store {
  const spec = COMPANION_VAULTS[which];
  return Store.open({
    driver: betterSqlite3Driver(db),
    vault: spec.vault,
    salt: spec.salt,
    modules: builtinModules(),
    companionReads: true, // the phone's store (openVaultStore)
  });
}

function build(which: "anna" | "home", today = TODAY) {
  const store = open(which);
  const result = buildCompanionVault(store, which, today, () => performance.now());
  return { store, result };
}

/** Anna's cash wallet: what was withdrawn minus what was spent in cash. */
const wallet = (store: Store) =>
  one<{ total: string }>(
    store,
    "SELECT printf('%.2f', SUM(CAST(t.amount AS REAL))) AS total FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE a.type = 'cash'",
  ).total;

const one = <T>(store: Store, sql: string, ...params: string[]): T => {
  const row = store.read<T>(sql, ...params)[0];
  if (row === undefined) throw new Error(`no row: ${sql}`);
  return row;
};

/** The usual month: PLN spending averaged over the closed months of the norm window. */
function usualSpending(store: Store) {
  const rows = runQuery(store, budgetScreenCashflow, { today: TODAY, currency: "PLN", period: {} })
    .value.rows;
  const norm = budget.closedMonthNorm(rows, TODAY);
  if (norm === null) throw new Error("no closed month");
  return norm.expense;
}

const within = (value: ReturnType<typeof D>, low: string, high: string) =>
  value.gte(D(low)) && value.lte(D(high));

function uncategorized(store: Store) {
  return one<{ n: number; total: number }>(
    store,
    `SELECT COUNT(*) AS n, COALESCE(SUM(-CAST(amount AS REAL)), 0) AS total FROM transactions
     WHERE category_source = 'default' AND booking_date LIKE ?`,
    `${MONTH}-%`,
  );
}

/** The newest batch's end as a local wall time. */
function newestBatch(store: Store) {
  const row = one<{ finished_at: string; source: string }>(
    store,
    "SELECT finished_at, source FROM import_batches ORDER BY finished_at DESC LIMIT 1",
  );
  const at = new Date(`${row.finished_at.replace(" ", "T").slice(0, 23)}Z`);
  const local = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  return { local, hour: at.getHours(), minute: at.getMinutes(), source: row.source };
}

const count = (store: Store, sql: string, ...params: string[]) =>
  one<{ n: number }>(store, sql, ...params).n;

describe("companion demo", () => {
  it("builds Anna: accounts, 36 months of batches, uncategorized and llm rows, transfers, car", () => {
    const { store, result } = build("anna");
    try {
      expect(result.vault).toBe(COMPANION_VAULTS.anna.vault);
      expect(result.months).toBe(36);
      expect(result.ms).toBeGreaterThan(0); // the build time is reported, not budgeted here (perf tier)
      expect(result.transactions).toBe(count(store, "SELECT COUNT(*) AS n FROM transactions"));
      expect(one<{ slug: string; name: string }>(store, "SELECT slug, name FROM profiles")).toEqual(
        { slug: "demo-anna", name: "Anna" },
      );
      // Three bank accounts and the cash pool the cash expenses opened.
      expect(
        count(
          store,
          "SELECT COUNT(*) AS n FROM accounts WHERE removed_at IS NULL AND type IN ('checking', 'savings', 'cash')",
        ),
      ).toBe(4);
      expect(
        store.read<{ n: number }>("SELECT COUNT(*) AS n FROM import_batches GROUP BY account_id"),
      ).toEqual([PER_ACCOUNT, PER_ACCOUNT, PER_ACCOUNT]);
      expect(uncategorized(store)).toEqual({ n: 4, total: 316 });
      expect(within(usualSpending(store), "8000", "9100")).toBe(true);
      expect(
        count(
          store,
          "SELECT COUNT(*) AS n FROM transactions WHERE category_source = 'llm' AND booking_date LIKE ?",
          `${MONTH}-%`,
        ),
      ).toBe(3);
      // Own transfers to savings: both legs matched by IBAN, every month.
      expect(
        count(
          store,
          "SELECT COUNT(*) AS n FROM transactions WHERE reference = 'PRZELEW WLASNY' AND is_internal_transfer = 1",
        ),
      ).toBe(2 * 36);
      expect(count(store, "SELECT COUNT(*) AS n FROM accounts WHERE type = 'vehicle'")).toBe(1);
      expect(count(store, "SELECT COUNT(*) AS n FROM depreciations")).toBe(1);
      // The housing payment gets housing from the seed rules; the salary is the owner's pin.
      expect(
        store.read<{ category: string }>(
          "SELECT DISTINCT category FROM transactions WHERE counterparty_name = 'SPOLDZIELNIA MIESZKANIOWA DEMO'",
        ),
      ).toEqual([{ category: "housing" }]);
      expect(
        store.read<{ category: string }>(
          "SELECT DISTINCT category FROM transactions WHERE counterparty_name = 'Northwind'",
        ),
      ).toEqual([{ category: "income_salary" }]);
      // The wallet: 300 withdrawn and spent every month, 320.00 left today.
      expect(wallet(store)).toBe("320.00");
      expect(newestBatch(store)).toEqual({
        local: TODAY,
        hour: 6,
        minute: 40,
        source: "open_banking",
      });
      expect(count(store, "SELECT COUNT(*) AS n FROM inv_strategy_versions")).toBe(1);
    } finally {
      store.close();
    }
  });

  it("builds Anna's portfolio: accounts, instruments, deposits, the fired alerts, research, strategy", () => {
    const { store } = build("anna");
    const cacheDb = new Database(":memory:");
    try {
      const read = store.read.bind(store);
      expect(investmentsQueries.brokerageAccounts(read).map((a) => a.name)).toEqual([
        "IKE",
        "Brokerage",
      ]);
      // Six held or watched instruments, plus the research candidate the vault knows.
      expect(investmentsQueries.watchlist(read).length).toBe(6);
      expect(investmentsQueries.vaultInstrumentGids(read).size).toBe(7);
      expect(
        count(store, "SELECT COUNT(*) AS n FROM inv_transactions WHERE type = 'deposit'"),
      ).toBeGreaterThanOrEqual(36);
      const open = investmentsQueries.openSignals(read);
      // Both CD Projekt alerts fired: the % move (waits for a decision) and the close below its 5-session
      // average (information).
      const alertSignals = open.filter((s) => s.ruleId.startsWith("alert:"));
      expect(alertSignals.map((s) => [s.kind, s.severity]).sort()).toEqual([
        ["alert:change_pct", "action"],
        ["alert:sma_cross", "info"],
      ]);
      const alerts = investmentsQueries.alerts(read, parseDateTime(`${TODAY}T07:00:00Z`));
      expect(alerts.map((a) => a.title).sort()).toEqual([
        "CDR -8% in 5 sessions",
        "CDR below its 5-session average",
      ]);
      expect(alerts.every((a) => a.lastTriggeredAt !== null)).toBe(true);
      const notes = investmentsResearch.noteRows(read, "1 = 1", []);
      expect(notes.filter((n) => n.thesisRelation === "weakens")).toHaveLength(1);
      const version = investmentsQueries.latestStrategyVersion(read);
      expect(version?.yamlText).toContain("monthly_amount: 2500");

      const prices = new SqlPriceCache(betterSqlite3Driver(cacheDb));
      seedCompanionDemoPrices(prices, TODAY);
      const sources = phoneInvestmentSources({ prices, now: () => `${TODAY}T07:00:00.000Z` });
      const state = sources.strategy.current(read);
      if (state.status !== "current") throw new Error(state.reason);
      expect(state.state.config?.review.every).toBe("week");
      expect(state.state.config?.contributions?.monthlyAmount.toString()).toBe("2500");
      const portfolio = runQuery(
        store,
        createMoneyQueries({ prices }, sources).investments.portfolio,
        {
          today: TODAY,
          lang: "en",
        },
      ).value;
      if (portfolio.status !== "ready") throw new Error(portfolio.reason);
      // CD Projekt about 7.4% of the portfolio at its last close; its alert fired today.
      const cdr = portfolio.positions.positions.find((p) => p.instrument.symbol === "CDR");
      expect(cdr?.value?.toString()).toBe("9657.00");
      expect(cdr?.weight).toBeGreaterThan(0.07);
      expect(cdr?.weight).toBeLessThan(0.08);
      // What the daily evaluation opened on this portfolio: the two alerts and the concentration rule
      // (tagged_weight and allocation_drift skip while CD Projekt is in no bucket; the deposits are on
      // plan, the cash is low and no ETF fell 20%).
      expect(open.map((s) => s.kind).sort()).toEqual([
        "alert:change_pct",
        "alert:sma_cross",
        "position_concentration",
      ]);
      expect(open.find((s) => s.kind === "position_concentration")?.ruleId).toBe(
        "single_stock_limit",
      );
    } finally {
      store.close();
      cacheDb.close();
    }
  });

  it("builds Home: two accounts, the loan matched by IBAN and phrase, the flat", () => {
    const { store, result } = build("home");
    try {
      expect(result.ms).toBeGreaterThan(0); // the build time is reported, not budgeted here (perf tier)
      expect(one<{ slug: string; name: string }>(store, "SELECT slug, name FROM profiles")).toEqual(
        { slug: "demo-home", name: "Home" },
      );
      expect(
        count(
          store,
          "SELECT COUNT(*) AS n FROM accounts WHERE type IN ('checking', 'savings', 'cash')",
        ),
      ).toBe(2);
      expect(
        store.read<{ n: number }>("SELECT COUNT(*) AS n FROM import_batches GROUP BY account_id"),
      ).toEqual([PER_ACCOUNT, PER_ACCOUNT]);
      expect(uncategorized(store)).toEqual({ n: 2, total: 303 });
      expect(within(usualSpending(store), "6900", "7700")).toBe(true);
      expect(count(store, "SELECT COUNT(*) AS n FROM loans")).toBe(1);
      expect(count(store, "SELECT COUNT(*) AS n FROM accounts WHERE type = 'property'")).toBe(1);
      expect(
        count(
          store,
          "SELECT COUNT(*) AS n FROM transactions WHERE reference = 'PRZELEW WLASNY' AND is_internal_transfer = 1",
        ),
      ).toBe(2 * 36);
      expect(
        store.read<{ category: string }>(
          "SELECT DISTINCT category FROM transactions WHERE reference = 'RATA KREDYTU HIPOTECZNEGO'",
        ),
      ).toEqual([{ category: "loans" }]);
      expect(newestBatch(store)).toEqual({
        local: TODAY,
        hour: 6,
        minute: 40,
        source: "open_banking",
      });
      // Rule 7: no row of Anna's vault is in Home's.
      expect(
        count(
          store,
          "SELECT COUNT(*) AS n FROM transactions WHERE bank_transaction_id LIKE 'CMP-A%'",
        ),
      ).toBe(0);
    } finally {
      store.close();
    }
  });

  it("is deterministic", () => {
    for (const which of ["anna", "home"] as const) {
      const a = build(which);
      const b = build(which);
      try {
        expect(viewHash(b.store).hash).toBe(viewHash(a.store).hash);
        expect(b.result.events).toBe(a.result.events);
      } finally {
        a.store.close();
        b.store.close();
      }
    }
  });

  // Month and year edges: the 1st, the 14th (the yearly car insurance), the end of February, the end
  // of January and New Year's Eve.
  it.each(["2026-03-01", "2026-03-14", "2026-02-28", "2026-01-31", "2026-12-31"])(
    "builds both vaults to completion on %s",
    (today) => {
      for (const which of ["anna", "home"] as const) {
        const { store } = build(which, today);
        try {
          expect(companionVaultComplete(store, which)).toBe(true);
          if (which === "anna") expect(wallet(store)).toBe("320.00");
          expect(newestBatch(store)).toMatchObject({ local: today, hour: 6, minute: 40 });
        } finally {
          store.close();
        }
      }
    },
    30_000,
  );

  it("tells a finished build from an empty or half-built vault", () => {
    const empty = open("home");
    try {
      expect(companionVaultComplete(empty, "home")).toBe(false);
    } finally {
      empty.close();
    }
    const db = new Database(":memory:");
    const store = open("home", db);
    try {
      buildCompanionVault(store, "home", TODAY, () => performance.now());
      expect(companionVaultComplete(store, "home")).toBe(true);
      // A build stopped before its last step (today's balances).
      db.prepare("DELETE FROM balances WHERE date = ?").run(TODAY);
      expect(companionVaultComplete(store, "home")).toBe(false);
    } finally {
      store.close();
    }
  });
});
