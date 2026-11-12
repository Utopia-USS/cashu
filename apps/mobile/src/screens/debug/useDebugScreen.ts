// Screen hook of the debug screen: reads the store live, rebuilds the demo vault's view from its log
// on request (and checks the rebuilt view equals the one it replaced), and logs the first frame with
// data once per launch (the S41 cold start measurement).

import { D } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import { type Store, viewHash } from "@cashu/store/runtime";
import { useQuery } from "@cashu/store-react";
import { type ChartTip, type DonutSegment, useUiEnv } from "@cashu/ui/native";
import { useRouter } from "expo-router";
import { type ReactNode, useEffect, useState, useTransition } from "react";
import { bootStartedAt } from "../../boot";
import type { CompanionBuild } from "../../fixture/companionDemo";
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

interface BalanceChart {
  values: number[];
  months: { i: number; text: string }[];
  tip: (i: number) => ChartTip;
}
const chartCache = new WeakMap<readonly BalanceRow[], Map<string, BalanceChart>>();
function balanceChart(rows: readonly BalanceRow[], locale: string): BalanceChart {
  let locales = chartCache.get(rows);
  if (!locales) {
    locales = new Map();
    chartCache.set(rows, locales);
  }
  let out = locales.get(locale);
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
          rows: r
            ? [
                {
                  name: S.balance,
                  value: formatDecimalValue(D(r.amount), locale, { currency: r.currency }).text,
                  amount: true,
                },
              ]
            : [],
        };
      },
    };
    locales.set(locale, out);
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

function built(build: CompanionBuild): DebugLoad {
  return { firstLaunch: true, events: build.events, applyMs: ms(build.ms), rebuild: null };
}

/** Rebuild the view from the held log and compare it with the view it replaced. */
function rebuildFromLog(store: Store): DebugLoad {
  const before = viewHash(store).hash;
  const t0 = performance.now();
  store.rebuild({ redecode: true, reindex: true });
  const rebuildMs = performance.now() - t0;
  const after = viewHash(store).hash;
  return {
    firstLaunch: false,
    events: store.read<{ n: number }>("SELECT COUNT(*) AS n FROM event_log")[0]?.n ?? 0,
    applyMs: null,
    rebuild: { ms: ms(rebuildMs), matches: before === after, viewHash: after },
  };
}

let firstDataLogged = false;

export function useDebugScreen(cryptoPanel: ReactNode): DebugViewProps {
  const { locale } = useUiEnv();
  const services = useServices();
  const { store } = services;
  const router = useRouter();
  const counts = useQuery(tableCounts, { tables: viewTables(store) });
  const balance = balanceChart(useQuery(firstAccountBalances), locale);
  const spendingByAccount = spending(useQuery(plnOutflowsByAccount));
  const [rebuilt, setRebuilt] = useState<DebugLoad | null>(null);
  const [rebuilding, startRebuild] = useTransition();
  const firstBuild = services.firstLoad.find((b) => b.vault === store.vault);
  const load = rebuilt ?? (firstBuild === undefined ? null : built(firstBuild));
  useEffect(() => {
    if (firstDataLogged) return;
    firstDataLogged = true;
    appendBenchLog({
      kind: "startup",
      jsStartAt: bootStartedAt,
      firstDataAt: Date.now(),
      openMs: services.openMs,
      firstLaunch: services.firstLoad.length > 0,
    });
  }, [services]);
  return {
    vault: store.vault,
    openMs: ms(services.openMs),
    load,
    tables: counts.filter((c) => c.rows > 0),
    cursors: store.cursors().size,
    needsUpgrade: store.needsUpgrade(),
    unfoldedTypes: store.unfoldedTypes().length,
    balanceTrend: balance.values,
    balanceMonths: balance.months,
    balanceAxis: (v) => formatDecimalValue(D(String(v)), locale, { fractionDigits: 0 }).text,
    balanceTip: balance.tip,
    spendingByAccount,
    cryptoPanel,
    rebuilding,
    onRebuild: () =>
      startRebuild(() => {
        setRebuilt(rebuildFromLog(store));
      }),
    onOpenBench: () => router.push("/bench"),
  };
}
