export interface SkeletonProps {
  /** Width: px number or a CSS length (default the full width). */
  width?: number | string;
  /** Height: px number or a CSS length (default 14). */
  height?: number | string;
  /** Corner: `control` 8px (default) or `widget` 12px (a placeholder widget). */
  radius?: "control" | "widget";
  /** Layout only (margin). */
  className?: string;
}

/** Loading placeholder block with the shimmer sweep (old `.skeleton`). */
export function Skeleton({
  width = "100%",
  height = 14,
  radius = "control",
  className = "",
}: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      className={`shimmer relative overflow-hidden bg-chip ${radius === "widget" ? "rounded-widget" : "rounded-control"} ${className}`}
      style={{ width, height }}
    />
  );
}
