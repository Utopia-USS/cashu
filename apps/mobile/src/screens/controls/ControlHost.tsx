import { Host } from "@expo/ui";
import type { ReactNode } from "react";
import { useCSSVariable } from "uniwind";

/**
 * Native controls inherit the same accent token as the surrounding shared display components. A
 * control fills the width by default; `inline` sizes it to its content (a picker inside a row of chips).
 */
export function ControlHost({ children, inline }: { children: ReactNode; inline?: boolean }) {
  const accent = useCSSVariable("--color-accent");
  const seed = typeof accent === "string" ? { seedColor: accent } : {};
  return inline === true ? (
    <Host matchContents {...seed}>
      {children}
    </Host>
  ) : (
    <Host matchContents={{ vertical: true }} style={{ width: "100%" }} {...seed}>
      {children}
    </Host>
  );
}
