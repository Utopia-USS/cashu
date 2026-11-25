// Scroll benchmark (S50 method): the list is driven programmatically at a fixed speed for 8 s; the JS
// thread's frames are requestAnimationFrame intervals, the UI thread's are Reanimated frame-callback
// intervals (display link). The frame budget follows the measured median (60 or 120 Hz).
import { useRef, useState } from "react";
import { useFrameCallback, useSharedValue } from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { type FrameReport, summarize } from "./frameStats";

export interface Scrollable {
  scrollToOffset(p: { offset: number; animated?: boolean }): void;
}

export interface ScrollRun {
  readonly label: string;
  readonly js: FrameReport;
  readonly ui: FrameReport;
  readonly hz: number;
}

export function usePerfHarness(onRun: (run: ScrollRun) => void) {
  const ui = useRef<number[]>([]);
  const [running, setRunning] = useState(false);
  const recording = useSharedValue(false);
  const push = (dt: number) => {
    ui.current.push(dt);
  };
  useFrameCallback((f) => {
    "worklet";
    if (recording.get() && f.timeSincePreviousFrame != null) {
      scheduleOnRN(push, f.timeSincePreviousFrame);
    }
  });

  const run = (list: Scrollable | null, pxPerSec = 4000, ms = 8000) => {
    if (!list || running) return;
    setRunning(true);
    ui.current = [];
    const js: number[] = [];
    let offset = 0;
    let last = 0;
    let start = 0;
    recording.set(true);
    const step = (now: number) => {
      if (start === 0) {
        start = now;
        last = now;
        requestAnimationFrame(step);
        return;
      }
      js.push(now - last);
      offset += (pxPerSec * (now - last)) / 1000;
      last = now;
      list.scrollToOffset({ offset, animated: false });
      if (now - start < ms) {
        requestAnimationFrame(step);
        return;
      }
      recording.set(false);
      const median = [...js].sort((a, b) => a - b)[Math.floor(js.length / 2)] ?? 16.7;
      const budget = median < 12 ? 1000 / 120 : 1000 / 60;
      setRunning(false);
      onRun({
        label: `scroll ${pxPerSec / 1000}k`,
        js: summarize(js, budget),
        ui: summarize(ui.current.slice(1), budget),
        hz: Math.round(1000 / budget),
      });
    };
    list.scrollToOffset({ offset: 0, animated: false });
    setTimeout(() => requestAnimationFrame(step), 300);
  };
  return { run, running };
}
