// The tab bar's data: which tabs the current profile shows (its enabled modules) and the accent tint.
import { enabledModules } from "@cashu/store/core/profile";
import { useQuery } from "@cashu/store-react";
import { useCSSVariable } from "uniwind";
import { type TabName, tabsFor } from "./tabs";

export function useTabs(): {
  readonly tabs: readonly TabName[];
  readonly tint: string | undefined;
} {
  const tabs = tabsFor(useQuery(enabledModules));
  const accent = useCSSVariable("--color-accent");
  return { tabs, tint: typeof accent === "string" ? accent : undefined };
}
