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
}: ButtonProps) {
  const [accent, danger, spacing] = useCSSVariable([
    "--color-accent",
    "--color-negative",
    "--spacing",
  ]);
  const seed = variant === "danger" ? danger : accent;
  const unit = Number.parseFloat(String(spacing));
  const padding = unit * ({ sm: 1, md: 2, lg: 3 } as const)[size];
  const nativeVariant =
    variant === "ghost" ? "text" : variant === "secondary" ? "outlined" : "filled";
  return (
    <Host matchContents seedColor={seed == null ? undefined : String(seed)}>
      <NativeButton
        label={children}
        onPress={onPress}
        disabled={disabled}
        variant={nativeVariant}
        style={{ padding }}
      />
    </Host>
  );
}
