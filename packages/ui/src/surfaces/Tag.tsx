import type { TagProps } from "./Tag.types.js";
import { TAG_FILL as fill } from "./tagFill.js";

export type { TagProps, TagTone } from "./Tag.types.js";

const outline = {
  neutral: "border-border text-fg-muted",
  positive: "border-positive text-positive",
  negative: "border-negative text-negative",
  warning: "border-warning text-warning",
  info: "border-info text-info",
} as const;
const shape =
  "inline-block whitespace-nowrap rounded-full border px-1.75 py-px text-2xs leading-normal";

/** Small outlined status label (old `.tag`, tones `.pos .neg .warn .info`, `.solid`). */
export function Tag({
  children,
  tone = "neutral",
  solid,
  title,
  onPress,
  className = "",
}: TagProps) {
  const look = `${shape} ${solid ? fill[tone] : outline[tone]} ${className}`;
  if (onPress)
    return (
      <button
        type="button"
        title={title}
        onClick={onPress}
        className={`${look} cursor-pointer ${solid ? "" : "bg-transparent"}`}
      >
        {children}
      </button>
    );
  return (
    <span title={title} className={look}>
      {children}
    </span>
  );
}
