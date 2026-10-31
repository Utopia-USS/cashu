import { useUiEnv } from "../environment/UiEnv.js";
import { areaScene } from "./areaScene.js";
import { ChartFrame } from "./platform.js";
import type { AreaChartProps } from "./types.js";
import { maskTip } from "./values.js";

/** Stacked area chart: assets stacked up from zero, liabilities down, the total as one line, with a
 * crosshair tooltip; a single layer fades like a line's area. */
export function AreaChart(props: AreaChartProps) {
  const { privacy } = useUiEnv();
  const { tooltip } = props;
  return (
    <ChartFrame
      width={props.width}
      height={props.height ?? 230}
      layout={props.layout}
      label={props.label}
      build={(w) => areaScene(props, w, privacy)}
      tooltip={tooltip ? (i) => maskTip(tooltip(i), privacy) : undefined}
    />
  );
}
