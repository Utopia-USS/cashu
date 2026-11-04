import type { ButtonProps } from "./Button.types.js";

const variants = {
  primary: "border-accent bg-accent text-fg-inverse hover:opacity-90",
  secondary: "border-border bg-surface-raised text-fg hover:bg-surface-sunken",
  danger: "border-negative bg-negative text-fg-inverse hover:opacity-90",
  ghost: "border-transparent bg-transparent text-fg hover:bg-surface-sunken",
} as const;
const sizes = {
  sm: "px-2 py-1 text-caption",
  md: "px-3 py-2 text-body",
  lg: "px-4 py-3 text-title",
} as const;
const selected =
  "aria-pressed:bg-accent-muted aria-pressed:text-accent aria-[current=page]:bg-accent-muted aria-[current=page]:text-accent";

/** Action button with semantic intent, a selected look for toggles and tabs, and a visible keyboard focus ring. */
export function Button({
  children,
  onPress,
  variant = "secondary",
  size = "md",
  disabled,
  type = "button",
  className = "",
  label,
  pressed,
  current,
  expanded,
  title,
  ref,
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      onClick={onPress}
      aria-label={label}
      aria-pressed={pressed}
      aria-current={current}
      aria-expanded={expanded}
      title={title}
      className={`rounded-sm border font-strong disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-focus ${variants[variant]} ${selected} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}
