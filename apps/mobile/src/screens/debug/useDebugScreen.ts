// Screen hook of the debug screen: reads the store live, rebuilds the demo vault from its log on
// request, and logs the first frame with data once per launch (the S41 cold start measurement).

import { intlLocale } from "@cashu/i18n";
import type { Store } from "@cashu/store";
import { useQuery } from "@cashu/store-react";
import type { ChartTip, DonutSegment } from "@cashu/ui";
import { useRouter } from "expo-router";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { bootStartedAt } from "../../boot";
import { type DemoLoad, loadDemo } from "../../fixture/loadDemo";
import { appendBenchLog } from "../../platform/benchLog";
import { useServices } from "../../services/ServicesProvider";
import { S } from "./Debug.strings";
import type { DebugLoad, DebugViewProps } from "./DebugView";
import { firstAccountBalances, plnOutflowsByAccount, tableCounts } from "./queries";

const tablesByStore = new WeakMap<Store, string[]>();
/** The store's public view tables (a closed set the store names). */
function viewTables(store: Store): string[] {
  let names = tablesByStore.get(store);
  if (!names) {
    names = store.publicTables().map((t) => t.name);
    tablesByStore.set(store, names);
  }
  return names;
}

const ms = (x: number) => String(Math.round(x));

interface BalanceRow {
  date: string;
  amount: string;
  currency: string;
}

// TRANSITIONAL(packages-ui-values): amounts are formatted here until <Money> exists in packages/ui.
let formats: { money: Map<string, Intl.NumberFormat>; axis: Intl.NumberFormat } | undefined;
function fmt() {
  formats ??= {
    money: new Map(),
    axis: new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 0 }),
  };
  return formats;
}
function money(amount: string, currency: string): string {
  const f = fmt();
  let m = f.money.get(currency);
  if (!m) {
    m = new Intl.NumberFormat(intlLocale(), { style: "currency", currency });
    f.money.set(currency, m);
  }
  return m.format(Number(amount));
}

interface BalanceChart {
  values: number[];
  months: { i: number; text: string }[];
  tip: (i: number) => ChartTip;
}
const chartCache = new WeakMap<readonly BalanceRow[], BalanceChart>();
function balanceChart(rows: readonly BalanceRow[]): BalanceChart {
  let out = chartCache.get(rows);
  if (!out) {
    const last = rows.length - 1;
    out = {
      values: rows.map((r) => Number(r.amount)),
      months: [0, Math.floor(last / 2), last]
        .filter((i) => i >= 0)
        .map((i) => ({ i, text: rows[i]?.date.slice(0, 7) ?? "" })),
      tip: (i) => {
        const r = rows[i];
        return {
          title: r?.date ?? "",
          rows: r ? [{ name: S.balance, value: money(r.amount, r.currency), amount: true }] : [],
        };
      },
    };
    chartCache.set(rows, out);
  }
  return out;
}

const spendingCache = new WeakMap<readonly { name: string; outflow: number }[], DonutSegment[]>();
function spending(rows: readonly { name: string; outflow: number }[]): DonutSegment[] {
  let out = spendingCache.get(rows);
  if (!out) {
    out = rows.map((r, i) => ({
      name: r.name,
      value: r.outflow,
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
  const counts = useQuery(tableCounts, { tables: viewTables(store) });
  const balance = balanceChart(useQuery(firstAccountBalances));
  const spendingByAccount = spending(useQuery(plnOutflowsByAccount));
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
    balanceTrend: balance.values,
    balanceMonths: balance.months,
    balanceAxis: (v) => fmt().axis.format(v),
    balanceTip: balance.tip,
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
