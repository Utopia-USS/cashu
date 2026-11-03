import { useUiEnv } from "../environment/UiEnv.js";
import { donutScene } from "./donutScene.js";
import { ChartFrame } from "./platform.js";
import type { DonutProps } from "./types.js";
import { MASK } from "./values.js";

/** Donut of shares (allocation) with surface gaps between segments and an optional centre value; the
 * accessible name speaks each segment's share. */
export function Donut(props: DonutProps) {
  const { privacy } = useUiEnv();
  const size = props.size ?? 112;
  const { center } = props;
  return (
    <ChartFrame
      width={size}
      height={size}
      layout={props.layout}
      label={props.label}
      onActivate={props.onSegmentSelected}
      build={() => donutScene(props)}
      center={
        center && {
          title: center.amount && privacy ? MASK : center.title,
          ...(center.caption != null ? { caption: center.caption } : {}),
        }
      }
    />
  );
}
