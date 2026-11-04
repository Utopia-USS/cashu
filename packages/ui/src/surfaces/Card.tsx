import type { CardProps } from "./Card.types.js";

const paddings = { md: "p-4", lg: "p-6" } as const;

/** Raised surface that groups one block of a screen: a panel, a form step, a status or failure notice. */
export function Card({
  children,
  as: Tag = "section",
  padding = "md",
  label,
  labelledBy,
  role,
  id,
  testID,
  onSubmit,
  onPointerDown,
  onPointerUp,
  className = "",
}: CardProps) {
  return (
    <Tag
      id={id}
      role={role}
      aria-label={label}
      aria-labelledby={labelledBy}
      data-testid={testID}
      onSubmit={onSubmit}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      className={`rounded-lg border border-border bg-surface-raised ${paddings[padding]} ${className}`}
    >
      {children}
    </Tag>
  );
}
