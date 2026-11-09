import { useUiEnv } from "../environment/UiEnv.js";
import { lineScene } from "./lineScene.js";
import { ChartFrame } from "./platform.js";
import type { LineChartProps } from "./types.js";
import { maskTip } from "./values.js";

/** Line chart of evenly sampled series with a benchmark, level lines, trade markers, end labels and a
 * crosshair tooltip (arrow keys / pointer on the desktop, touch scrub / VoiceOver adjust on mobile). */
export function LineChart(props: LineChartProps) {
  const { privacy } = useUiEnv();
  const { tooltip } = props;
  return (
    <ChartFrame
      width={props.width}
      height={props.height ?? 230}
      layout={props.layout}
      label={props.label}
      build={(w) => lineScene(props, w, privacy)}
      tooltip={tooltip ? (i) => maskTip(tooltip(i), privacy) : undefined}
      onScrub={props.onScrub}
    />
  );
}
