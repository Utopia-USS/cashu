import { layoutClass } from "../layout.js";
import type { ValueStyle } from "./types.js";

export interface ValueTextProps extends ValueStyle {
  readonly text: string;
  readonly accessibleText: string;
}
const SIZES = {
  caption: "text-caption",
  body: "text-body",
  title: "text-title",
  headline: "text-headline",
  display: "text-display",
};
const TONES = {
  default: "text-fg",
  muted: "text-fg-muted",
  positive: "text-positive",
  negative: "text-negative",
};
export function valueClasses({
  size = "body",
  tone = "default",
  weight = "regular",
  layout,
}: ValueStyle): string {
  return [
    "tabular-nums",
    SIZES[size],
    TONES[tone],
    weight === "strong" ? "font-strong" : "font-regular",
    layoutClass(layout),
  ].join(" ");
}
