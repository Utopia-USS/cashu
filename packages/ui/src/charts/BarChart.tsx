import { useUiEnv } from "../environment/UiEnv.js";
import { barScene } from "./barScene.js";
import { ChartFrame } from "./platform.js";
import type { BarChartProps } from "./types.js";
import { maskTip } from "./values.js";

/** Bars per period (month) with an optional dashed plan line, category and value labels; the accessible
 * name lists every value. */
export function BarChart(props: BarChartProps) {
  const { privacy } = useUiEnv();
  const { tooltip } = props;
  return (
    <ChartFrame
      width={props.width}
      height={props.height ?? 120}
      layout={props.layout}
      label={props.label}
      tooltip={tooltip ? (i) => maskTip(tooltip(i), privacy) : undefined}
      build={(w) => barScene(props, w, privacy)}
    />
  );
}
