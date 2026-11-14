// The desktop's filled status pill (old `.htag`, `.hr-pill`, `.rd .pill`); kept apart from Tag.tsx so
// the Tag pair (Tag.tsx / Tag.native.tsx) exposes one identical surface on both platforms.
import type { ReactNode } from "react";
import type { TagTone } from "./Tag.types.js";
import { TAG_FILL as fill } from "./tagFill.js";

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
