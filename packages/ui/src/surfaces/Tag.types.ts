import type { ReactNode } from "react";

export type TagTone = "neutral" | "positive" | "negative" | "warning" | "info";

export interface TagProps {
  children: ReactNode;
  /** Text and outline colour; `neutral` (default) is muted on the border colour. */
  tone?: TagTone;
  /** Tinted fill instead of the outline (neutral: the chip fill). Native tags are always filled. */
  solid?: boolean;
  /** Tooltip (desktop). */
  title?: string;
  /** Makes the tag a button (e.g. a status that leads to its cause). */
  onPress?: () => void;
  /** Layout only. */
  className?: string;
}
