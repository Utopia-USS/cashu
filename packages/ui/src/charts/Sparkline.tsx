import { ChartFrame } from "./platform.js";
import { SPARK_H, SPARK_W, sparkScene } from "./sparkScene.js";
import type { SparklineProps } from "./types.js";

/** Inline 72 x 22 trend line for a table row, toned by first vs last value; decorative without a label. */
export function Sparkline(props: SparklineProps) {
  return (
    <ChartFrame
      width={SPARK_W}
      height={SPARK_H}
      layout={props.layout}
      label={props.label ?? ""}
      build={() => sparkScene(props)}
      decorative={!props.label}
      inline
    />
  );
}
