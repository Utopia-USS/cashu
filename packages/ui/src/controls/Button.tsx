import type { ButtonProps } from "./Button.types.js";

// The Python app's buttons (old index.css): `.btn` (chip face), `.btn.primary`, `.btn.ghost`, `.lnk`
// (underlined text link) and `.icon-btn` (bare glyph). Weight 400 like the old UA button font.
const frame = "cursor-pointer whitespace-nowrap leading-cozy disabled:cursor-default";
const variants = {
  primary: `${frame} rounded-control border border-accent bg-accent text-on-accent disabled:opacity-60`,
  secondary: `${frame} rounded-control border border-border bg-chip text-chip-fg disabled:opacity-60`,
  danger: `${frame} rounded-control border border-negative bg-negative text-on-accent disabled:opacity-60`,
  ghost: `${frame} rounded-control border border-border bg-transparent text-chip-fg disabled:opacity-60`,
  link: "cursor-pointer border-0 bg-transparent p-0 text-accent underline underline-offset-2 disabled:cursor-default disabled:text-fg-muted disabled:no-underline",
  icon: "cursor-pointer border-0 bg-transparent px-1.5 py-0.5 text-base leading-control text-fg-muted hover:text-negative disabled:cursor-default disabled:opacity-60",
} as const;
// `.btn` 5px 10px / 12px, `.btn.sm` 2px 7px / 11.5px, lg (no old twin) 7px 14px / 14px. A link takes its
// size from where the old `.lnk` sat: sm = widget footer (12px), md = widget body (12.5px), lg = plain (13px).
const boxSizes = {
  sm: "px-1.75 py-0.5 text-2xs-plus",
  md: "px-2.5 py-1.25 text-xs",
  lg: "px-3.5 py-1.75 text-md",
} as const;
const linkSizes = { sm: "text-xs", md: "text-xs-plus", lg: "text-sm" } as const;
// `.btn.on`: a pressed toggle or the current item of a set keeps its face and takes an accent border.
const selected = "aria-pressed:border-accent aria-[current=page]:border-accent";
const weights = { regular: "font-regular", strong: "font-strong" } as const;

/** Action button with semantic intent, a selected look for toggles and tabs, and a visible keyboard focus ring. */
export function Button({
  children,
  onPress,
  variant = "secondary",
  size = "md",
  weight = "regular",
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
  const sized =
    variant === "link"
      ? linkSizes[size]
      : variant === "icon"
        ? ""
        : `${boxSizes[size]} ${selected}`;
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
      className={`${variants[variant]} ${sized} ${weights[weight]} ${className}`}
    >
      {children}
    </button>
  );
}
