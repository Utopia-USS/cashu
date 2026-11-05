import { cls } from "./classes.js";
import { BG } from "./look.js";
import { colorRole } from "./scene.js";
import type { SwatchProps } from "./types.js";

const SIZE: Record<NonNullable<SwatchProps["size"]>, string> = {
  /** `.arow .sw`: 10 px, radius 3 px. */
  md: "size-2.5 rounded-3xs",
  /** `.legend i.sw`: 9 px, radius 2 px. */
  sm: "size-2.25 rounded-4xs",
  /** `.swatch`: 12 px, radius 3 px. */
  lg: "size-3 rounded-3xs",
};

/** The colour key of a donut segment or a stacked layer in a row or a legend (decorative). */
export function Swatch({ color, size = "md" }: SwatchProps) {
  return <span className={cls("block shrink-0", SIZE[size], BG[colorRole(color)])} aria-hidden />;
}
