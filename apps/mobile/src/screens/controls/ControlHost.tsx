import { Host } from "@expo/ui";
import type { ReactNode } from "react";
import { useCSSVariable } from "uniwind";

/** Native controls inherit the same accent token as the surrounding shared display components. */
export function ControlHost({ children }: { children: ReactNode }) {
  const accent = useCSSVariable("--color-accent");
  return (
    <Host
      matchContents={{ vertical: true }}
      style={{ width: "100%" }}
      {...(typeof accent === "string" ? { seedColor: accent } : {})}
    >
      {children}
    </Host>
  );
}
