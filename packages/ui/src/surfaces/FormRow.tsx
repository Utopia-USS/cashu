import type { ReactNode } from "react";

export interface FormRowProps {
  /** The fields side by side; they wrap below 180px each. */
  children: ReactNode;
  /** Layout only (margin). */
  className?: string;
}

/** Fields side by side in a form (old `.form-row`: auto-fit columns of at least 180px, gap 12px). */
export function FormRow({ children, className = "" }: FormRowProps) {
  return (
    <div
      className={`grid gap-3 ${className}`}
      style={{ gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}
    >
      {children}
    </div>
  );
}
