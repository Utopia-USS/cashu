import { Host, Button as NativeButton } from "@expo/ui";
import { useCSSVariable } from "uniwind";
import type { ButtonProps } from "./Button.types.js";

/** Native action button with the same intent roles as the desktop control. */
export function Button({
  children,
  onPress,
  variant = "secondary",
  size = "md",
  disabled,
  label,
  pressed,
  current,
}: ButtonProps) {
  const [accent, danger, spacing] = useCSSVariable([
    "--color-accent",
    "--color-negative",
    "--spacing",
  ]);
  const seed = variant === "danger" ? danger : accent;
  const text = typeof children === "string" ? children : undefined;
  const unit = Number.parseFloat(String(spacing));
  const padding = unit * ({ sm: 1, md: 2, lg: 3 } as const)[size];
  const nativeVariant =
    pressed || current || variant === "primary" || variant === "danger"
      ? "filled"
      : variant === "ghost"
        ? "text"
        : "outlined";
  return (
    <Host matchContents seedColor={seed == null ? undefined : String(seed)}>
      <NativeButton
        label={text ?? label}
        onPress={onPress}
        disabled={disabled}
        variant={nativeVariant}
        style={{ padding }}
      >
        {text === undefined ? children : undefined}
      </NativeButton>
    </Host>
  );
}
