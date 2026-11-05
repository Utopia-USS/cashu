import type { ReactNode } from "react";

export interface FieldNoteProps {
  children: ReactNode;
  /** `negative` = a validation error (old `.fe`); default a muted hint (old `.fhint`). */
  tone?: "negative";
  id?: string;
  /** Layout only (margin). */
  className?: string;
}

/** A 12px line of a form field (old `.fhint` muted hint / `.field .fe` error in the negative colour). */
export function FieldNote({ children, tone, id, className = "" }: FieldNoteProps) {
  return (
    <span
      id={id}
      className={`text-xs ${tone === "negative" ? "text-negative" : "text-fg-muted"} ${className}`}
    >
      {children}
    </span>
  );
}
