// Mount benchmark (S50 method): N rows mounted at once (no virtualization), 7 runs; the wall time from
// the state change to the layout effect (render + commit on the JS thread). React's Profiler is a
// no-op in release builds, so wall time is the metric.
import { type ReactNode, useLayoutEffect, useState } from "react";
import { View } from "react-native";

const RUNS = 7;

export interface MountRun {
  readonly rows: number;
  readonly medianMs: number;
  readonly minMs: number;
  readonly runs: number;
}

function Batch(props: {
  n: number;
  t0: number;
  renderRow: (i: number) => ReactNode;
  onMounted: (ms: number) => void;
}) {
  const { n, t0, renderRow, onMounted } = props;
  useLayoutEffect(() => {
    onMounted(performance.now() - t0);
  }, [onMounted, t0]);
  return (
    <View className="absolute inset-x-0 top-0 opacity-0" pointerEvents="none">
      {Array.from({ length: n }, (_, i) => renderRow(i))}
    </View>
  );
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function useMountBench(
  n: number,
  renderRow: (i: number) => ReactNode,
  onDone: (run: MountRun) => void,
) {
  const [state, setState] = useState<{ run: number; t0: number; times: number[] } | null>(null);
  const start = () => setState({ run: 1, t0: performance.now(), times: [] });
  const onMounted = (ms: number) => {
    if (!state) return;
    const times = [...state.times, ms];
    setTimeout(() => {
      if (state.run < RUNS) {
        setState(null);
        setTimeout(() => setState({ run: state.run + 1, t0: performance.now(), times }), 60);
        return;
      }
      const sorted = [...times].sort((a, b) => a - b);
      onDone({
        rows: n,
        medianMs: round1(sorted[Math.floor(RUNS / 2)] ?? 0),
        minMs: round1(sorted[0] ?? 0),
        runs: RUNS,
      });
      setState(null);
    }, 60);
  };
  return {
    start,
    running: state !== null,
    node: state ? (
      <Batch key={state.run} n={n} t0={state.t0} renderRow={renderRow} onMounted={onMounted} />
    ) : null,
  };
}
