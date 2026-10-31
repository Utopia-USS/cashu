// Stories of the list benchmark (CSF 3, synthetic rows): idle, with results, while running.

import { BenchView, type BenchViewProps } from "./BenchView";
import type { TxItem } from "./TxRow";

const items: TxItem[] = Array.from({ length: 40 }, (_, i) => ({
  id: i + 1,
  title: `SKLEP OSIEDLOWY ${String(i % 7).padStart(2, "0")}`,
  subtitle: `2026-10-${String(1 + (i % 28)).padStart(2, "0")} · groceries`,
  amount: `-${(10 + i).toFixed(2)} zł`,
  negative: true,
}));

const base: BenchViewProps = {
  items,
  busy: false,
  report: [],
  onScroll4k: () => {},
  onScroll12k: () => {},
  onMount500: () => {},
};

const meta = { title: "Mobile/Bench", component: BenchView, args: base };
export default meta;

export const Idle = { args: base };
export const WithResults = {
  args: {
    ...base,
    report: [
      "scroll 4k: JS 60fps 0% p95 17.2 worst 20.1 | UI 60fps 0% p95 16.9 worst 17.5 @60Hz",
      "mount 500: median 170 ms, min 165 ms (7 runs)",
    ],
  },
};
export const Running = { args: { ...base, busy: true } };
