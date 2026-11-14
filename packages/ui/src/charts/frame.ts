// The contract between the shared chart components and the platform frame (platform.tsx on the desktop,
// platform.native.tsx on mobile): the frame measures the width, builds the scene, draws it, and owns the
// interaction (pointer / keys on the desktop, touch scrub / VoiceOver adjust on mobile) and the tooltip.
import type { Layout } from "../layout.js";
import type { Built } from "./scene.js";
import type { ChartTip } from "./types.js";

export interface ChartFrameProps {
  /** Fixed width in px; omit to measure the parent. */
  width?: number;
  height: number;
  layout?: Layout;
  label: string;
  onActivate?: ((index: number) => void) | undefined;
  /** Pointer hover over a path that carries a `hover` index (desktop only); null when it leaves. */
  onHover?: ((index: number | null) => void) | undefined;
  build: (width: number) => Built;
  /** The focused index while the user scrubs (pointer, arrow keys, touch), null when the scrub ends. The caller
   * shows the point itself (e.g. in a hero figure): the floating tip is then drawn for assistive technology
   * only (its live region still announces it). */
  onScrub?: ((index: number | null) => void) | undefined;
  /** Tooltip for a focused index, already privacy-masked; makes a scrubbable scene interactive. */
  tooltip?: ((i: number) => ChartTip) | undefined;
  /** Centre text (donut), already privacy-masked. */
  center?: { title: string; caption?: string } | undefined;
  /** No accessible name: hidden from assistive technology (an unlabelled sparkline). */
  decorative?: boolean;
  /** Sits inline in text or a table cell (sparkline). */
  inline?: boolean;
}

/** One line of tooltip text: what the live region announces and the adjustable value reads. */
export const tipText = (tip: ChartTip): string =>
  [tip.title, ...tip.rows.map((r) => `${r.name} ${r.value}`)].join(", ");

/** Next focused index after a step (arrow key, VoiceOver increment); starts from the last point. */
export const stepIndex = (cur: number | null, delta: number, n: number): number =>
  Math.max(0, Math.min(n - 1, (cur ?? n - 1) + delta));
