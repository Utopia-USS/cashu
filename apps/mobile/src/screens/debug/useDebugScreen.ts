// Screen hook of the debug screen: reads the store live, rebuilds the demo vault from its log on
// request, and logs the first frame with data once per launch (the S41 cold start measurement).
import type { Store } from "@cashu/store";
import type { DonutSegment } from "@cashu/ui";
import { useRouter } from "expo-router";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { bootStartedAt } from "../../boot";
import { type DemoLoad, loadDemo } from "../../fixture/loadDemo";
import { appendBenchLog } from "../../platform/benchLog";
import { useServices } from "../../services/ServicesProvider";
import { useStoreRows } from "../../services/useStoreRows";
import type { DebugLoad, DebugViewProps } from "./DebugView";

const sqlByStore = new WeakMap<Store, string>();
/** One query counting every public table (the store names them; a closed set). */
function countsSql(store: Store): string {
  let sql = sqlByStore.get(store);
  if (!sql) {
    sql = store
      .publicTables()
      .map((t) => `SELECT '${t.name}' AS "table", COUNT(*) AS rows FROM ${t.name}`)
      .join(" UNION ALL ");
    sqlByStore.set(store, sql);
  }
  return sql;
}

const ms = (x: number) => String(Math.round(x));

const BALANCES_SQL =
  "SELECT b.amount AS amount FROM balances b WHERE b.account_id = (SELECT MIN(id) FROM accounts) ORDER BY b.date";
// One currency only: shares of PLN outflows per PLN account (never summed across currencies).
const SPENDING_SQL =
  "SELECT a.name AS name, t.amount AS amount FROM transactions t JOIN accounts a ON a.id = t.account_id WHERE t.currency = 'PLN' AND t.amount LIKE '-%' ORDER BY a.id";

const trendCache = new WeakMap<readonly { amount: string }[], number[]>();
function trend(rows: readonly { amount: string }[]): number[] {
  let out = trendCache.get(rows);
  if (!out) {
    out = rows.map((r) => Number(r.amount));
    trendCache.set(rows, out);
  }
  return out;
}

const spendingCache = new WeakMap<readonly { name: string; amount: string }[], DonutSegment[]>();
function spending(rows: readonly { name: string; amount: string }[]): DonutSegment[] {
  let out = spendingCache.get(rows);
  if (!out) {
    const byName = new Map<string, number>();
    for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? 0) - Number(r.amount));
    out = [...byName].map(([name, value], i) => ({
      name,
      value: Math.round(value),
      color: (i + 1) as DonutSegment["color"],
    }));
    spendingCache.set(rows, out);
  }
  return out;
}

function summary(load: DemoLoad, firstLaunch: boolean): DebugLoad {
  return {
    firstLaunch,
    events: load.events,
    applyMs: ms(load.applyMs),
    rebuildMs: ms(load.rebuildMs),
    rebuildMatches: load.rebuildMatches,
    viewHash: load.hashAfterRebuild,
  };
}

let firstDataLogged = false;

export function useDebugScreen(cryptoPanel: ReactNode): DebugViewProps {
  const services = useServices();
  const { store } = services;
  const router = useRouter();
  const counts = useStoreRows<{ table: string; rows: number }>(store, countsSql(store));
  const balanceTrend = trend(useStoreRows<{ amount: string }>(store, BALANCES_SQL));
  const spendingByAccount = spending(
    useStoreRows<{ name: string; amount: string }>(store, SPENDING_SQL),
  );
  const [rebuilt, setRebuilt] = useState<DemoLoad | null>(null);
  const [rebuilding, startRebuild] = useTransition();
  const load = rebuilt ?? services.firstLoad;
  useEffect(() => {
    if (firstDataLogged) return;
    firstDataLogged = true;
    appendBenchLog({
      kind: "startup",
      jsStartAt: bootStartedAt,
      firstDataAt: Date.now(),
      openMs: services.openMs,
      firstLaunch: services.firstLoad !== null,
    });
  }, [services]);
  return {
    vault: store.vault,
    openMs: ms(services.openMs),
    load: load === null ? null : summary(load, rebuilt === null),
    tables: counts.filter((c) => c.rows > 0),
    cursors: store.cursors().size,
    needsUpgrade: store.needsUpgrade(),
    unfoldedTypes: store.unfoldedTypes().length,
    balanceTrend,
    spendingByAccount,
    cryptoPanel,
    rebuilding,
    onRebuild: () =>
      startRebuild(() => {
        store.reset();
        setRebuilt(loadDemo(store, () => performance.now()));
      }),
    onOpenBench: () => router.push("/bench"),
  };
}
