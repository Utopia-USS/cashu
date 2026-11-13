// The phone companion's cross-module reads over real in-memory vaults: upcoming charges against the
// paying accounts, the month with its bills, the attention list and the month close with a synced
// strategy. Every row is invented.
import { D, parseDateTime } from "@cashu/domain";
import type { RawTransaction } from "@cashu/domain/budget";
import { strategyTemplate } from "@cashu/domain/investments/strategy";
import { describe, expect, it } from "vitest";
import { importStatement, setTransactionCategory } from "../budget/commands.js";
import { createProfile, recordBalance, setModules } from "../core/commands.js";
import { createPlannedDeposit } from "../investments/commands/planned.js";
import { saveStrategyVersion } from "../investments/commands/strategy.js";
import { applyRaw, raw, rawGid } from "../investments/commands/testing/fixtures.js";
import { strategySnapshot } from "../investments/desktop/sources.js";
import { signalsOwnerCommands } from "../investments/desktop-signals/commands.js";
import { movingPortfolio } from "../investments/research/testing/fixtures.js";
import { addLoan } from "../loans/commands.js";
import type { Store } from "../materialize.js";
import { type Read, runQuery } from "../query.js";
import { run, type TestEnv, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { companionQueries } from "./companion.js";

const TODAY = "2026-03-20";
const NOW = "2026-03-20T12:00:00.000Z";
const OWN_A = "PL10114000000000000000001234";
const OWN_B = "PL10124000000000000000003334";

type Row = {
  readonly date: string;
  readonly amount: string;
  readonly name: string;
  readonly ref: string;
  readonly category?: string;
};

function vault(modules: readonly string[]) {
  const store = openTestStore();
  const env = testEnv({ wall: Date.parse(NOW) });
  const created = run(store, env, createProfile, {
    slug: "synthetic-companion",
    name: "Synthetic companion",
    baseCurrency: "PLN",
    modules,
  });
  if (!created.ok) throw new Error("synthetic profile refused");
  return { store, env };
}

function ingest(store: Store, env: TestEnv, number: string, rows: readonly Row[]): string {
  const transactions: RawTransaction[] = rows.map((r) => ({
    bookingDate: r.date,
    valueDate: null,
    amount: D(r.amount),
    currency: "PLN",
    counterpartyName: r.name,
    counterpartyIban: null,
    description: r.ref,
    reference: r.ref,
    bankTransactionId: null,
    source: "csv",
    raw: { synthetic: r.ref },
  }));
  const imported = run(store, env, importStatement, {
    statement: {
      bank: "mbank",
      accountNumber: number,
      accountName: `Synthetic ${number.slice(-4)}`,
      currency: "PLN",
      transactions,
      balances: [],
      closingBalances: [],
    },
    newestDayRule: false,
  });
  if (!imported.ok) throw new Error("synthetic import refused");
  for (const row of rows) {
    if (row.category === undefined) continue;
    const txn = store.read<{ gid: string }>(
      "SELECT gid FROM transactions WHERE reference = ? AND dedup_hash NOT LIKE 'cashleg:%'",
      row.ref,
    )[0]?.gid;
    if (!txn || !run(store, env, setTransactionCategory, { txn, category: row.category }).ok)
      throw new Error("synthetic category refused");
  }
  const account = store.read<{ gid: string }>(
    "SELECT gid FROM accounts WHERE name = ?",
    `Synthetic ${number.slice(-4)}`,
  )[0]?.gid;
  if (!account) throw new Error("missing synthetic account");
  return account;
}

const balance = (store: Store, env: TestEnv, account: string, amount: string) => {
  const done = run(store, env, recordBalance, {
    account,
    date: "2026-03-19",
    amount,
    source: "csv",
  });
  if (!done.ok) throw new Error("synthetic balance refused");
};

const queries = companionQueries();

describe("core.companionUpcoming and core.companionMonth", () => {
  it("lists a subscription, a planned deposit and a loan installment against the paying accounts", () => {
    const { store, env } = vault(["budget", "loans", "investments"]);
    try {
      const a = ingest(store, env, OWN_A, [
        ...["2025-11-22", "2025-12-22", "2026-01-22", "2026-02-22"].map((date, i) => ({
          date,
          amount: "-43.00",
          name: "NETFLIX.COM",
          ref: `nf-${i}`,
        })),
        // next due 03-28: past the 7-day list, still this month's bill
        ...["2025-11-28", "2025-12-28", "2026-01-28", "2026-02-28"].map((date, i) => ({
          date,
          amount: "-20.00",
          name: "SPOTIFY",
          ref: `sp-${i}`,
        })),
      ]);
      const b = ingest(store, env, OWN_B, [
        { date: "2026-02-25", amount: "-1798.65", name: "BANK", ref: "RATA KREDYTU 02/2026" },
      ]);
      const txn = store.read<{ gid: string }>(
        "SELECT gid FROM transactions WHERE reference = 'RATA KREDYTU 02/2026'",
      )[0]?.gid;
      expect(run(store, env, setTransactionCategory, { txn, category: "loans" }).ok).toBe(true);
      expect(
        run(store, env, addLoan, {
          name: "Synthetic mortgage",
          type: "mortgage",
          principal: "300000",
          annualRate: "6",
          termMonths: 360,
          startDate: "2025-01-25",
          paymentText: "rata kredytu",
        }).ok,
      ).toBe(true);
      expect(
        run(store, env, createPlannedDeposit, {
          amount: "1000",
          plannedDate: "2026-03-24",
          note: "Synthetic IKE",
        }).ok,
      ).toBe(true);
      balance(store, env, a, "30.00");
      balance(store, env, b, "5000.00");

      const upcoming = runQuery(store, queries.upcoming, { today: TODAY }).value;
      expect(
        upcoming.rows.map((r) => [
          r.kind,
          r.when,
          r.daysUntil,
          r.payee,
          r.account?.name ?? null,
          r.covered,
          r.shortfall?.toString() ?? null,
        ]),
      ).toEqual([
        ["subscription", "2026-03-22", 2, "NETFLIX.COM", "Synthetic 1234", false, "13.00"],
        ["planned", "2026-03-24", 4, "Synthetic IKE", null, null, null],
        ["installment", "2026-03-25", 5, "Synthetic mortgage", "Synthetic 3334", true, null],
      ]);
      const installment = upcoming.rows[2];
      expect(installment?.amount.lt(D("0"))).toBe(true);
      expect(upcoming.uncovered.map((r) => r.payee)).toEqual(["NETFLIX.COM"]);
      const payment = installment?.amount.copyAbs() ?? D("0");
      expect(upcoming.totals.PLN).toEqual(D("-1043.00").sub(payment));
      expect(
        runQuery(store, queries.upcoming, { today: TODAY, horizonDays: 3 }).value.rows,
      ).toHaveLength(1);

      const month = runQuery(store, queries.month, {
        today: TODAY,
        currency: "PLN",
        lang: "pl",
      }).value;
      // the bills run to the month's end (the 28th Spotify too), not the 7-day list
      expect(month.billsDue).toEqual(D("1063.00").add(payment));
      expect(month.projection.remainingSpend).toEqual(month.billsDue);
      const february = runQuery(store, queries.month, {
        today: TODAY,
        currency: "PLN",
        month: "2026-02",
        lang: "pl",
      }).value;
      expect(february.billsDue.isZero()).toBe(true);
      expect(
        runQuery(store, queries.month, {
          today: TODAY,
          currency: "PLN",
          month: "2026-04",
          lang: "pl",
        }).value.billsDue.isZero(),
      ).toBe(true);

      // Loans and investments switched off: no installment, no planned deposit
      expect(run(store, env, setModules, { moduleIds: ["budget"] }).ok).toBe(true);
      expect(
        runQuery(store, queries.upcoming, { today: TODAY }).value.rows.map((r) => r.kind),
      ).toEqual(["subscription"]);
      expect(
        runQuery(store, queries.month, { today: TODAY, currency: "PLN", lang: "pl" }).value
          .billsDue,
      ).toEqual(D("63.00"));
    } finally {
      store.close();
    }
  });
});

describe("core.attention", () => {
  it("ranks the Netflix price rise as a tier-4 row through the store", () => {
    const { store, env } = vault(["budget"]);
    try {
      const months = ["2025-11", "2025-12", "2026-01", "2026-02"];
      ingest(store, env, OWN_A, [
        ...months.flatMap((m, i) => [
          { date: `${m}-03`, amount: "-49.00", name: "NETFLIX.COM", ref: `nf-${i}` },
          { date: `${m}-08`, amount: "-1000.00", name: "BIEDRONKA", ref: `bied-${i}` },
        ]),
        { date: "2026-03-03", amount: "-60.00", name: "NETFLIX.COM", ref: "nf-new" },
      ]);
      const attention = runQuery(store, queries.attention, {
        today: TODAY,
        currency: "PLN",
        now: NOW,
      }).value;
      expect(attention.banner).toBeNull();
      expect(attention.rows.map((r) => [r.tier, r.subject.id, r.reason.kind])).toEqual([
        [4, "NETFLIX.COM:PLN:49.00", "payee_price_up"],
      ]);
      const reason = attention.rows[0]?.reason;
      if (reason?.kind !== "payee_price_up") throw new Error("expected a price rise");
      expect([
        reason.from.toString(),
        reason.to.toString(),
        reason.yearlyEffect.toString(),
      ]).toEqual(["49.00", "60.00", "132.00"]);

      const stale = runQuery(store, queries.attention, {
        today: TODAY,
        currency: "PLN",
        now: "2026-03-22T12:00:00.000Z",
      }).value;
      expect(stale.banner).toEqual({ kind: "stale", ageHours: 48 });
    } finally {
      store.close();
    }
  });

  it("a one-off purchase at a subscription merchant is no price rise", () => {
    const { store, env } = vault(["budget"]);
    try {
      const months = ["2025-11", "2025-12", "2026-01", "2026-02"];
      ingest(store, env, OWN_A, [
        ...months.flatMap((m, i) => [
          { date: `${m}-22`, amount: "-50.00", name: "TELCO TEST", ref: `telco-${i}` },
          { date: `${m}-08`, amount: "-1000.00", name: "BIEDRONKA", ref: `bied-${i}` },
        ]),
        // a phone bought in the telco's shop: not the bill
        { date: "2026-03-02", amount: "-300.00", name: "TELCO TEST", ref: "telco-phone" },
      ]);
      const attention = runQuery(store, queries.attention, {
        today: TODAY,
        currency: "PLN",
        now: NOW,
      }).value;
      expect(attention.rows).toEqual([]);
      const upcoming = runQuery(store, queries.upcoming, { today: TODAY }).value;
      expect(upcoming.rows.map((r) => [r.key, r.when, r.amount.toString()])).toEqual([
        ["TELCO TEST:PLN:50.00", "2026-03-22", "-50.00"],
      ]);
    } finally {
      store.close();
    }
  });
});

const STRATEGY = `version: 1
base_currency: PLN
buckets:
  - id: stocks
    match: { asset_class: [equity, etf] }
allocation:
  targets: { stocks: 1.0 }
contributions:
  monthly_amount: 1500
  day_of_month: 10
`;

describe("core.companionMonthClose", () => {
  it("compares the surplus with the synced strategy's plan and finds the month's planned deposit", () => {
    const { store, env } = vault(["budget", "investments"]);
    try {
      ingest(store, env, OWN_A, [
        { date: "2026-02-10", amount: "5000.00", name: "ACME SP Z O O", ref: "pay" },
        { date: "2026-02-12", amount: "-1000.00", name: "BIEDRONKA", ref: "bied" },
      ]);
      const close = (month: string | null) =>
        runQuery(store, queries.monthClose, { today: TODAY, month, lang: "en" }).value;
      expect(close("2026-02").investing?.planned).toBeNull();

      expect(run(store, env, saveStrategyVersion, { yamlText: STRATEGY }).ok).toBe(true);
      expect(
        run(store, env, createPlannedDeposit, { amount: "1500", plannedDate: "2026-04-10" }).ok,
      ).toBe(true);
      const planned = run(store, env, createPlannedDeposit, {
        amount: "1500",
        plannedDate: "2026-03-10",
      });
      if (!planned.ok) throw new Error("synthetic plan refused");
      const feb = close("2026-02");
      expect(feb.month).toBe("2026-02");
      expect(feb.complete).toBe(true);
      expect(feb.investing?.planned).toEqual({
        amount: D("1500"),
        currency: "PLN",
        dayOfMonth: 10,
      });
      expect(feb.investing?.comparison?.surplus).toEqual(D("4000.00"));
      expect(feb.plannedDeposit).toEqual({
        gid: planned.value.plan,
        amount: D("1500"),
        currency: "PLN",
      });
      expect(close("2026-03").plannedDeposit?.amount).toEqual(D("1500"));
      expect(close("2026-01").plannedDeposit).toBeNull();
      expect(() => close("2026-00")).toThrow(RangeError);
      // investments switched off: no plan, no planned deposit on the closed month
      expect(run(store, env, setModules, { moduleIds: ["budget"] }).ok).toBe(true);
      expect(close("2026-02").plannedDeposit).toBeNull();
    } finally {
      store.close();
    }
  });
});

describe("core.attention positions (tier 2)", () => {
  // The investments research fixture's moving portfolio (ABC +10 % in the week, WRLD, a bond, XMPL)
  // on 2026-10-31, with the passive starter strategy as the synced strategy and its own price cache.
  function investing() {
    const fixture = movingPortfolio();
    const { v, abc, wrld, edox, xmpl, cache } = fixture;
    v.value(createProfile, {
      slug: "synthetic-investor",
      name: "Synthetic investor",
      baseCurrency: "PLN",
      modules: ["budget", "investments"],
    });
    const template = strategyTemplate("passive_etf");
    if (!template) throw new Error("missing passive_etf template");
    const changes = { subscribe: () => () => {} };
    const sources = {
      strategy: {
        changes,
        current: (read: Read) =>
          strategySnapshot(read, {
            vault: v.store.vault,
            generation: "test",
            revision: "one",
            files: { yaml: template.yaml, md: template.markdown, readError: null },
          }),
      },
      market: { changes, current: () => ({ prices: cache }), newestRateDate: () => null },
      clock: {
        changes,
        current: () => ({ now: parseDateTime(INV_NOW), timeZone: "Europe/Warsaw" }),
      },
    };
    const alert = rawGid(9101);
    const fired = rawGid(9102);
    const decided = rawGid(9103);
    applyRaw(v, [
      raw.alertCreated(alert, abc, { severity: "action", title: "ABC below 52" }),
      raw.signalOpened(fired, `alert:${alert}|abc`, { severity: "action", instrument: abc }),
      raw.signalOpened(decided, "drop|edox", { severity: "action", instrument: edox }),
      raw.noteAdded(rawGid(9104), wrld, {
        thesisRelation: "weakens",
        observedAt: "2026-10-27T08:00:00.000Z",
      }),
      // Three weeks old: no longer a fresh verdict.
      raw.noteAdded(rawGid(9105), xmpl, {
        thesisRelation: "invalidates",
        observedAt: "2026-10-10T08:00:00.000Z",
      }),
    ]);
    v.value(signalsOwnerCommands.acknowledge, { signal: decided });
    return { ...fixture, sources, fired };
  }
  const INV_NOW = "2026-10-31T12:00:00.000Z";
  const args = { today: "2026-10-31", currency: "PLN", now: INV_NOW };

  it("ranks a fired alert and a fresh weakening verdict with their weights; decided and old ones stay out", () => {
    const { v, abc, wrld, sources, fired } = investing();
    try {
      const attention = runQuery(v.store, companionQueries({}, sources).attention, args).value;
      const tier2 = attention.rows.filter((r) => r.tier === 2);
      expect(tier2.map((r) => r.subject.id).sort()).toEqual([abc, wrld].sort());
      const byId = new Map(tier2.map((r) => [r.subject.id, r]));
      const abcRow = byId.get(abc);
      if (abcRow?.reason.kind !== "position") throw new Error("expected the ABC position");
      expect(abcRow.reason).toMatchObject({
        instrument: { id: abc, name: "ABC SA" },
        alertFired: true,
        researchVerdict: null,
        dayMove: 0,
      });
      expect(abcRow.magnitude.kind).toBe("percent");
      if (abcRow.magnitude.kind === "percent") expect(abcRow.magnitude.value).toBeGreaterThan(0.2);
      expect(byId.get(wrld)?.reason).toMatchObject({
        alertFired: false,
        researchVerdict: "weakens",
      });
      expect(attention.positions[abc]?.signal).toBe(fired);
      expect(attention.positions[abc]?.week).toBeCloseTo(0.1, 6);
      expect(attention.positions[wrld]?.signal).toBeNull();
      expect(Object.keys(attention.positions).sort()).toEqual([abc, wrld].sort());
    } finally {
      v.store.close();
    }
  });

  it("without the investments sources only the fired alert ranks (no weights)", () => {
    const { v, abc } = investing();
    try {
      const attention = runQuery(v.store, companionQueries().attention, args).value;
      expect(attention.rows.filter((r) => r.tier === 2).map((r) => r.subject.id)).toEqual([abc]);
      expect(attention.positions[abc]?.week).toBeNull();
    } finally {
      v.store.close();
    }
  });
});
