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

/** Action button with semantic intent and a visible keyboard focus ring. */
export function Button({
  children,
  onPress,
  variant = "secondary",
  size = "md",
  disabled,
  type = "button",
  className = "",
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onPress}
      className={`rounded-sm border font-strong disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-focus ${variants[variant]} ${sizes[size]} ${className}`}
    >
      {children}
    </button>
  );
}
