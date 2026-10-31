// Screen hook of the debug screen: reads the store live, suspends once on the crypto self-test (it
// runs after the first frame), rebuilds the demo vault from its log on request.
import type { Store } from "@cashu/store";
import { useRouter } from "expo-router";
import { use, useState, useTransition } from "react";
import { type DemoLoad, loadDemo } from "../../fixture/loadDemo";
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

export function useDebugScreen(): DebugViewProps {
  const services = useServices();
  const { store } = services;
  const router = useRouter();
  const crypto = use(services.cryptoSelfTest);
  const counts = useStoreRows<{ table: string; rows: number }>(store, countsSql(store));
  const [rebuilt, setRebuilt] = useState<DemoLoad | null>(null);
  const [rebuilding, startRebuild] = useTransition();
  const load = rebuilt ?? services.firstLoad;
  return {
    vault: store.vault,
    openMs: ms(services.openMs),
    load: load === null ? null : summary(load, rebuilt === null),
    tables: counts.filter((c) => c.rows > 0),
    cursors: store.cursors().size,
    needsUpgrade: store.needsUpgrade(),
    unfoldedTypes: store.unfoldedTypes().length,
    crypto,
    rebuilding,
    onRebuild: () =>
      startRebuild(() => {
        store.reset();
        setRebuilt(loadDemo(store, () => performance.now()));
      }),
    onOpenBench: () => router.push("/bench"),
  };
}
