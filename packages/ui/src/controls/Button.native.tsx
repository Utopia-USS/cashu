// The phone's button (visual.md section 2 `.btn`): a React Native Pressable in the spec's looks, not an
// @expo/ui button (those are accent-filled at natural width; the design's primary is ink-filled). Framed
// variants are 36 / 44 / 48 pt tall; the bare `icon` / `glyph` variants are a 44 pt square hit area around
// an `Icon` node and take their accessible name from `label`.
import { cloneElement, isValidElement, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useResolveClassNames } from "uniwind";
import type { ButtonProps } from "./Button.types.js";
import { usePressPending } from "./usePressPending.js";

export type { ButtonProps } from "./Button.types.js";

type Variant = NonNullable<ButtonProps["variant"]>;

// Face of the pressable (background, frame) and tone of its text per variant.
const faces: Record<Variant, string> = {
  primary: "bg-fg",
  secondary: "border border-border-strong bg-chip",
  danger: "bg-negative-bg",
  ghost: "bg-transparent",
  link: "",
  icon: "",
  glyph: "",
};
const tones: Record<Variant, string> = {
  primary: "text-surface",
  secondary: "text-fg",
  danger: "text-negative",
  ghost: "text-fg-secondary",
  link: "text-accent",
  icon: "text-fg-secondary",
  glyph: "text-fg-secondary",
};
const frameSizes = { sm: "h-9 px-3", md: "h-11 px-4", lg: "h-12 px-5" } as const;
const textSizes = { sm: "text-body", md: "text-body", lg: "text-title" } as const;
// A pressed toggle or the current item of a set: the subtle face with the accent frame (the desktop's
// `.btn.on` border).
const SELECTED = "border border-accent bg-subtle";
const FRAMED = "flex-row items-center justify-center gap-2 rounded-button-lg";
const BARE = "min-h-11 min-w-11 items-center justify-center";
// A text link is shorter than the 44 pt target; the slop makes up the difference.
const LINK_SLOP = { top: 12, bottom: 12, left: 8, right: 8 } as const;

function isFramed(variant: Variant): boolean {
  return variant !== "link" && variant !== "icon" && variant !== "glyph";
}

/** Recolours an `Icon` child (its stroke follows its `className` text colour) for the bare variants. */
function tinted(children: ReactNode, tone: string): ReactNode {
  return isValidElement<{ className?: string }>(children)
    ? cloneElement(children, { className: tone })
    : children;
}

/** Action button with semantic intent, a selected look for toggles and tabs, and a busy state (a spinner
 * over the kept-size content) while its action runs. */
export function Button({
  children,
  onPress,
  pending,
  variant = "secondary",
  size = "md",
  weight = "regular",
  disabled,
  className = "",
  label,
  pressed,
  current,
  expanded,
  block,
}: ButtonProps) {
  const busy = usePressPending(onPress, pending);
  const framed = isFramed(variant);
  const bare = variant === "icon" || variant === "glyph";
  const selected = Boolean(pressed) || current !== undefined;
  const text = typeof children === "string" ? children : undefined;
  // The selected face is subtle whatever the variant, so its text takes the plain ink; a pressed bare
  // glyph (a toggle such as "tell this phone") has no face and turns accent instead.
  const tone = selected
    ? framed
      ? "text-fg"
      : bare
        ? "text-accent"
        : tones[variant]
    : tones[variant];
  const { color: spinnerColor } = useResolveClassNames(tone);
  const strong = variant === "primary" || weight === "strong";
  const face = framed
    ? `${FRAMED} ${frameSizes[size]} ${selected ? SELECTED : faces[variant]}`
    : bare
      ? BARE
      : "justify-center";
  const content = (pressedIn: boolean) => {
    if (bare) {
      return tinted(children, variant === "icon" && pressedIn ? "text-negative" : tone);
    }
    if (text === undefined) return children;
    return (
      <Text
        numberOfLines={1}
        className={`${textSizes[size]} ${strong ? "font-strong" : "font-medium"} ${tone}`}
      >
        {text}
      </Text>
    );
  };
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label ?? text}
      accessibilityState={{
        disabled: Boolean(disabled),
        busy: busy.inFlight,
        selected: selected || undefined,
        expanded,
      }}
      disabled={disabled}
      // `press` itself ignores presses while one is in flight.
      onPress={busy.press}
      hitSlop={variant === "link" ? LINK_SLOP : undefined}
      className={`${face} ${block ? "w-full" : className.includes("self-") ? "" : "self-start"} ${disabled ? "opacity-50" : "active:opacity-80"} ${className}`}
    >
      {({ pressed: pressedIn }) =>
        busy.visible ? (
          <View className="items-center justify-center">
            {/* opacity, not removal: the content keeps the button's size while the spinner runs */}
            <View className="opacity-0">{content(false)}</View>
            <View className="absolute inset-0 items-center justify-center">
              <ActivityIndicator
                size="small"
                color={spinnerColor == null ? undefined : String(spinnerColor)}
              />
            </View>
          </View>
        ) : (
          content(pressedIn)
        )
      }
    </Pressable>
  );
}
