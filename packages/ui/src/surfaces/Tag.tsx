import type { ReactNode } from "react";

export type TagTone = "neutral" | "positive" | "negative" | "warning" | "info";

export interface TagProps {
  children: ReactNode;
  /** Text and outline colour; `neutral` (default) is muted on the border colour. */
  tone?: TagTone;
  /** Tinted fill instead of the outline (neutral: the chip fill). */
  solid?: boolean;
  title?: string;
  /** Makes the tag a button (e.g. a status that leads to its cause). */
  onPress?: () => void;
  /** Layout only. */
  className?: string;
}

const outline = {
  neutral: "border-border text-fg-muted",
  positive: "border-positive text-positive",
  negative: "border-negative text-negative",
  warning: "border-warning text-warning",
  info: "border-info text-info",
} as const;
const fill = {
  neutral: "border-transparent bg-chip text-fg-muted",
  positive: "border-transparent bg-positive-bg text-positive",
  negative: "border-transparent bg-negative-bg text-negative",
  warning: "border-transparent bg-warning-bg text-warning",
  info: "border-transparent bg-info-bg text-info",
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

export interface PillProps {
  children: ReactNode;
  tone: Exclude<TagTone, "neutral">;
  /** Padding: `sm` 2px 8px (rail summary pills), `md` 2px 9px (rail tags, default), `lg` 3px 9px (deck card pill). */
  size?: "sm" | "md" | "lg";
  title?: string;
  /** Layout only (e.g. `ml-auto`). */
  className?: string;
}

const pillPads = { sm: "px-2 py-0.5", md: "px-2.25 py-0.5", lg: "px-2.25 py-0.75" } as const;

/** Filled 12px semibold status pill without a border (old `.htag`, `.hr-pill`, `.rd .pill`). */
export function Pill({ children, tone, size = "md", title, className = "" }: PillProps) {
  return (
    <span
      title={title}
      className={`whitespace-nowrap rounded-full text-xs font-strong ${pillPads[size]} ${fill[tone]} border-0 ${className}`}
    >
      {children}
    </span>
  );
}
