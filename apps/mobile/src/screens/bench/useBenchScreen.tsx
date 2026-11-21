// Screen hook of the list benchmark: store rows -> list items, the S50 scroll / mount runs, results
// shown and appended to documents/bench/results.jsonl. `?autorun=1` runs the S50 sequence by itself
// (no HID tool on this Mac): 3 x scroll 4k, 1 x scroll 12k, 1 x mount 500.
import { D, Money } from "@cashu/domain";
import { useQuery } from "@cashu/store-react";
import type { FlashListRef } from "@shopify/flash-list";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { appendBenchLog } from "../../platform/benchLog";
import { S } from "./Bench.strings";
import type { BenchViewProps } from "./BenchView";
import { useMountBench } from "./perf/useMountBench";
import { usePerfHarness } from "./perf/usePerfHarness";
import { benchTransactions } from "./queries";
import { type TxItem, TxRow } from "./TxRow";

interface TxDbRow {
  id: number;
  booking_date: string;
  amount: string;
  currency: string;
  counterparty_name: string | null;
  category: string | null;
}

const itemsCache = new WeakMap<readonly TxDbRow[], TxItem[]>();
function toItems(rows: readonly TxDbRow[]): TxItem[] {
  const hit = itemsCache.get(rows);
  if (hit) return hit;
  const items = rows.map((r) => ({
    id: r.id,
    title: r.counterparty_name ?? "",
    date: r.booking_date,
    category: r.category ?? S.uncategorized,
    amount: new Money(D(r.amount), r.currency),
    negative: r.amount.startsWith("-"),
  }));
  itemsCache.set(rows, items);
  return items;
}

const fmt = (r: { fps: number; droppedPct: number; p95Ms: number; worstMs: number }) =>
  `${r.fps}fps ${r.droppedPct}% p95 ${r.p95Ms} worst ${r.worstMs}`;

export function useBenchScreen(): BenchViewProps {
  const { autorun } = useLocalSearchParams<{ autorun?: string }>();
  const items = toItems(useQuery(benchTransactions));
  const listRef = useRef<FlashListRef<TxItem>>(null);
  const [report, setReport] = useState<readonly string[]>([]);
  const add = (line: string) => setReport((r) => [...r, line]);

  const perf = usePerfHarness((run) => {
    add(`${run.label}: JS ${fmt(run.js)} | UI ${fmt(run.ui)} @${run.hz}Hz`);
    appendBenchLog({ kind: "scroll", rows: items.length, ...run });
  });
  const mount = useMountBench(
    500,
    (i) => <TxRow key={i} item={items[i % Math.max(items.length, 1)] as TxItem} />,
    (run) => {
      add(`mount ${run.rows}: median ${run.medianMs} ms, min ${run.minMs} ms (${run.runs} runs)`);
      appendBenchLog({ kind: "mount", ...run });
    },
  );

  const runStep = useEffectEvent((step: number) => {
    if (step < 3) perf.run(listRef.current);
    else if (step === 3) perf.run(listRef.current, 12000);
    else mount.start();
  });
  useEffect(() => {
    if (autorun !== "1") return;
    const timers = [3000, 13000, 23000, 33000, 43000].map((ms, step) =>
      setTimeout(() => runStep(step), ms),
    );
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, [autorun]);

  return {
    items,
    listRef,
    busy: perf.running || mount.running,
    report,
    onScroll4k: () => perf.run(listRef.current),
    onScroll12k: () => perf.run(listRef.current, 12000),
    onMount500: mount.start,
    overlay: mount.node,
  };
}
