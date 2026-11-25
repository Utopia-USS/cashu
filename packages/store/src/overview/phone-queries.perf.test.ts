// Timing of the phone's tab queries and of the categorize write on the M4.1 workload: a synthetic
// 60,000-row mBank statement (the generator of the real-project run: card payments at 400 synthetic
// shops over five years, a monthly salary, one account) imported into a phone-configured store
// (`companionReads: true`). An announced benchmark: CASHU_PERF=1 runs it, the default tier skips it.
// Prints one `PHONE_QUERIES {...}` line: per tab, each query's first run and median (ms), the tab's
// total, and the categorize command (apply) and the re-runs of the queries it wakes. V8 is about ten
// times faster than Hermes: the budgets on the phone (tap -> visible 300 ms, a tab 500 ms) are about
// 30 / 50 ms here. Synthetic data only.
//
//   CASHU_PERF=1 pnpm --filter @cashu/store exec vitest run src/overview/phone-queries.perf.test.ts
import { budget, core } from "@cashu/domain";
import { describe, expect, it } from "vitest";
import { importStatement, setTransactionCategory } from "../budget/commands.js";
import {
  budgetCategoryOptions,
  budgetCompanionCurrencies,
  budgetCompanionSpending,
  budgetSearch,
  budgetTransactions,
  budgetUncategorizedCount,
} from "../budget/companion-queries.js";
import { dataFreshness } from "../budget/freshness.js";
import {
  budgetScreenCurrencies as bookCurrencies,
  budgetScreenSpending as bookSpending,
} from "../budget/screen-queries.js";
import { createProfile } from "../core/commands.js";
import { enabledModules, profileIdentity } from "../core/profile.js";
import { type Query, type QueryArgs, runQuery } from "../query.js";
import type { SqlValue } from "../sql/driver.js";
import { run, testEnv } from "../testing/commands.js";
import { openTestStore } from "../testing/store.js";
import { accountsQuery, assetsQuery } from "./accounts.js";
import { bananaScaleQuery } from "./bananas.js";
import { companionQueries } from "./companion.js";
import { netWorthNowQuery, netWorthQueries, type OverviewSources } from "./networth.js";

const ENABLED = process.env.CASHU_PERF === "1";
const ROWS = Number(process.env.CASHU_PERF_ROWS ?? 60_000);
const TODAY = "2026-11-14";
const NOW = "2026-11-14T12:00:00.000Z";
const RUNS = 5;

/** The run's generator (`~/cashu-lab/m41-real-run/gen-mbank.mjs`), UTF-8. */
export function syntheticMbank(n: number): Uint8Array {
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const start = Date.UTC(2021, 10, 15);
  const end = Date.UTC(2026, 10, 14);
  const days = Math.round((end - start) / 864e5) + 1;
  const perDay = n / days;
  const pl = (c: number) => {
    const [a, b] = (Math.abs(c) / 100).toFixed(2).split(".") as [string, string];
    return `${c < 0 ? "-" : ""}${a.replace(/\B(?=(\d{3})+(?!\d))/g, " ")},${b}`;
  };
  let bal = 2_000_000;
  const open = bal;
  let cr = 0;
  let db = 0;
  const rows: string[] = [];
  let i = 0;
  for (let d = 0; d < days && i < n; d++) {
    const ds = new Date(start + d * 864e5).toISOString().slice(0, 10);
    let k = Math.floor(perDay) + (rnd() < perDay % 1 ? 1 : 0);
    if (d === days - 1) k = n - i;
    for (let j = 0; j < k && i < n; j++, i++) {
      if (ds.endsWith("-10") && j === 0) {
        const amt = 900_000;
        bal += amt;
        cr += amt;
        rows.push(
          `${ds};${ds};PRZELEW PRZYCHODZĄCY;"WYNAGRODZENIE TEST ${ds.slice(0, 7)}";"PRACODAWCA TEST SP. Z O.O.";'99102000000000000000009902';${pl(amt)};${pl(bal)};`,
        );
      } else {
        const m = String(1 + Math.floor(rnd() * 400)).padStart(4, "0");
        const amt = -(100 + Math.floor(rnd() * 4500));
        bal += amt;
        db += amt;
        rows.push(
          `${ds};${ds};ZAKUP PRZY UŻYCIU KARTY;"SKLEP TEST ${m}/MIASTO TEST   DATA TRANSAKCJI: ${ds}";"";'';${pl(amt)};${pl(bal)};`,
        );
      }
    }
  }
  const head = [
    "mBank S.A. Bankowość Detaliczna;",
    "",
    "#Waluta;",
    "PLN;",
    "",
    "#Numer rachunku;",
    "99 1140 0000 0000 0000 0000 9901;",
    "",
    "#Saldo początkowe;#Uznania;#Obciążenia;",
    `${pl(open)};${pl(cr)};${pl(db)};`,
    "",
    "#Data księgowania;#Data operacji;#Opis operacji;#Tytuł;#Nadawca/Odbiorca;#Numer konta;#Kwota;#Saldo po operacji;",
  ];
  return new TextEncoder().encode(
    [...head, ...rows, `;;;;;;#Saldo końcowe;${pl(bal)};`, ""].join("\r\n"),
  );
}

/** A phone-configured store holding the synthetic statement (every module enabled, as the demo). */
export function phoneWorkload(rows = ROWS) {
  const store = openTestStore({ companionReads: true });
  const env = testEnv();
  const ok = <R>(out: { ok: boolean; value?: R; reason?: string }) => {
    if (!out.ok) throw new Error(out.reason);
    return out.value as R;
  };
  ok(
    run(store, env, createProfile, {
      slug: "perf",
      name: "Perf",
      baseCurrency: "PLN",
      modules: ["budget", "assets", "loans", "investments"],
    }),
  );
  const parsed = budget.parseStatementFile(
    syntheticMbank(rows),
    core.builtinRegistry().institutions,
    "mbank",
  );
  if (!parsed.ok) throw new Error(`parse: ${parsed.reason}`);
  ok(
    run(store, env, importStatement, {
      statement: parsed.statement,
      source: "csv",
      filename: "synthetic.csv",
      newestDayRule: false,
    }),
  );
  return { store, env };
}

type Tab = readonly (readonly [Query<QueryArgs, unknown>, QueryArgs])[];

/** The queries each tab mounts (args as the screen hooks pass them on 2026-11-14, Polish UI). */
export function phoneTabs(): Record<string, Tab> {
  const ctx = { prices: null };
  // As the phone's `createMoneyQueries` (apps/mobile/src/services/moneyQueries.ts) builds them;
  // CASHU_PERF_BOOK=1: the book-based read models (before M4.1 C2).
  const phone: OverviewSources =
    process.env.CASHU_PERF_BOOK === "1" ? {} : { companionReads: true };
  const nw = netWorthQueries(ctx, phone);
  const summary = process.env.CASHU_PERF_BOOK === "1" ? nw.summary : netWorthNowQuery(ctx, phone);
  const companion = companionQueries(phone);
  const book = process.env.CASHU_PERF_BOOK === "1";
  const budgetScreenCurrencies = book ? bookCurrencies : budgetCompanionCurrencies;
  const budgetScreenSpending = book ? bookSpending : budgetCompanionSpending;
  const q = <A extends QueryArgs>(query: Query<A, unknown>, args: A) =>
    [query as unknown as Query<QueryArgs, unknown>, args as QueryArgs] as const;
  const shell = [
    q(profileIdentity, undefined),
    q(dataFreshness, undefined),
    q(enabledModules, undefined),
    q(bananaScaleQuery(ctx, phone), { today: TODAY }),
  ];
  return {
    shell,
    today: [
      q(companion.month, { today: TODAY, currency: "PLN", lang: "pl" }),
      q(companion.upcoming, { today: TODAY }),
      q(companion.attention, { today: TODAY, currency: "PLN", now: NOW }),
      q(companion.monthClose, { today: TODAY, month: "2026-10", lang: "pl" }),
      q(companion.month, { today: TODAY, currency: "PLN", month: "2026-10", lang: "pl" }),
    ],
    activity: [
      q(accountsQuery(ctx, phone), { today: TODAY }),
      q(budgetScreenCurrencies, { today: TODAY }),
      q(budgetCategoryOptions, { lang: "pl", today: TODAY }),
      q(budgetTransactions, { filter: "all", account: null, category: null, limit: 50 }),
      q(budgetUncategorizedCount, {}),
      q(budgetSearch, { q: "", lang: "pl" }),
    ],
    netWorth: [
      q(summary, { today: TODAY }),
      q(nw.hero, { today: TODAY }),
      q(accountsQuery(ctx, phone), { today: TODAY }),
      q(assetsQuery(ctx, phone), { today: TODAY }),
      q(nw.netWorthSeries, { today: TODAY, currency: "PLN", lang: "pl", convert: false }),
    ],
    spending: [
      q(budgetScreenCurrencies, { today: TODAY }),
      q(companion.month, { today: TODAY, currency: "PLN", month: "2026-11", lang: "pl" }),
      q(budgetScreenSpending, {
        today: TODAY,
        currency: "PLN",
        period: { year: 2026, month: 11 },
        lang: "pl",
      }),
    ],
  };
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
const ms = (x: number) => Math.round(x * 10) / 10;

describe.skipIf(!ENABLED)("phone tab queries at 60k rows (CASHU_PERF=1)", () => {
  it("times every tab's queries and the categorize write", async () => {
    const t0 = performance.now();
    const { store, env } = phoneWorkload();
    const buildMs = performance.now() - t0;
    const tabs = phoneTabs();
    if (process.env.CASHU_PERF_SQL === "1") {
      console.log(
        "GROUPS",
        JSON.stringify(
          store.read(
            "SELECT merchant_key, currency, count(*) AS n, min(last_date) AS lo, max(last_date) AS hi FROM fold_recurring GROUP BY 1, 2 ORDER BY n DESC LIMIT 5",
          ),
        ),
        JSON.stringify(
          store.read(
            "SELECT merchant_key, count(*) AS n FROM fold_recurring_rows GROUP BY 1 ORDER BY n DESC LIMIT 5",
          ),
        ),
        JSON.stringify(store.read("SELECT count(*) AS n FROM fold_recurring")),
      );
    }
    const report: Record<string, unknown> = { rows: ROWS, buildMs: ms(buildMs) };
    for (const [tab, queries] of Object.entries(tabs)) {
      const per: Record<string, { first: number; median: number }> = {};
      let total = 0;
      for (const [query, args] of queries) {
        const times: number[] = [];
        for (let i = 0; i < RUNS; i++) {
          const s = performance.now();
          runQuery(store, query, args);
          times.push(performance.now() - s);
        }
        const key = per[query.id] === undefined ? query.id : `${query.id}#2`;
        per[key] = { first: ms(times[0] ?? 0), median: ms(median(times)) };
        total += median(times);
      }
      report[tab] = { total: ms(total), per };
    }
    // Categorize one row; then every mounted query whose tables the apply touched re-runs (what the
    // phone's live queries do after the command). `card`: the newest card payment, in the group of the
    // bank's generic phrase (every card payment: the worst case); `salary`: a salary row (a small
    // group, as a demo payee).
    const mounted = Object.values(tabs).flat();
    const categorize = (gid: string) => {
      const reads = mounted.map(([query, args]) => runQuery(store, query, args).tables);
      let touched: ReadonlySet<string> = new Set();
      const stop = store.subscribe(
        store.publicTables().map((t) => t.name),
        (tables) => {
          touched = tables;
        },
      );
      const s = performance.now();
      const out = run(store, env, setTransactionCategory, { txn: gid, category: "transport" });
      const applyMs = performance.now() - s;
      stop();
      expect(out.ok).toBe(true);
      const r0 = performance.now();
      const rerun: Record<string, number> = {};
      mounted.forEach(([query, args], i) => {
        const read = reads[i] as ReadonlySet<string>;
        if (![...read].some((t) => touched.has(t))) return;
        const s1 = performance.now();
        runQuery(store, query, args);
        rerun[query.id] = ms((rerun[query.id] ?? 0) + performance.now() - s1);
      });
      return {
        applyMs: ms(applyMs),
        touched: [...touched].sort(),
        rerunMs: ms(performance.now() - r0),
        rerun,
      };
    };
    const pick = (sql: string) => {
      const gid = store.read<{ gid: string }>(sql)[0]?.gid;
      expect(typeof gid).toBe("string");
      return gid as string;
    };
    report.categorizeCard = categorize(
      pick(
        "SELECT gid FROM transactions WHERE counterparty_iban IS NULL ORDER BY booking_date DESC, id DESC LIMIT 1",
      ),
    );
    report.categorizeSalary = categorize(
      pick(
        "SELECT gid FROM transactions WHERE counterparty_iban IS NOT NULL ORDER BY booking_date DESC, id DESC LIMIT 1",
      ),
    );
    console.log(`PHONE_QUERIES ${JSON.stringify(report)}`);
    const profileTo = process.env.CASHU_PERF_PROFILE;
    if (profileTo !== undefined) {
      // A CPU profile of one run of every mounted query (open it in Chrome DevTools).
      const { Session } = await import("node:inspector/promises");
      const { writeFileSync } = await import("node:fs");
      const session = new Session();
      session.connect();
      await session.post("Profiler.enable");
      await session.post("Profiler.start");
      for (const [query, args] of mounted) runQuery(store, query, args);
      const other = store.read<{ gid: string }>(
        "SELECT gid FROM transactions WHERE counterparty_iban IS NULL ORDER BY booking_date DESC, id DESC LIMIT 1 OFFSET 3",
      )[0]?.gid as string;
      run(store, env, setTransactionCategory, { txn: other, category: "transport" });
      const { profile } = await session.post("Profiler.stop");
      writeFileSync(profileTo, JSON.stringify(profile));
      session.disconnect();
    }
    if (process.env.CASHU_PERF_SQL === "1") {
      // Where each query's time goes: its slowest statements, and the time outside SQL.
      for (const [query, args] of mounted) {
        const sql = new Map<string, number>();
        const calls = new Map<string, number>();
        const source = {
          read: <R>(text: string, ...params: SqlValue[]): R[] => {
            const s2 = performance.now();
            const rows = store.read<R>(text, ...params);
            sql.set(text, (sql.get(text) ?? 0) + performance.now() - s2);
            calls.set(text, (calls.get(text) ?? 0) + 1);
            return rows;
          },
          tablesRead: (text: string) => store.tablesRead(text),
          subscribe: () => () => {},
        };
        const s3 = performance.now();
        runQuery(source, query, args);
        const all = performance.now() - s3;
        const inSql = [...sql.values()].reduce((a, b) => a + b, 0);
        const top = [...sql].sort((a, b) => b[1] - a[1]).slice(0, 4);
        console.log(
          `SQL ${query.id} total=${ms(all)} sql=${ms(inSql)} js=${ms(all - inSql)}\n${top
            .map(([t, v]) => `  ${ms(v)} x${calls.get(t)} ${t.replace(/\s+/g, " ").slice(0, 220)}`)
            .join("\n")}`,
        );
      }
    }
  }, 600_000);
});
