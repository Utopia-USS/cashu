import type { SetupAction } from "@cashu/domain/core";

export type SetupNavigation =
  | { readonly kind: "module"; readonly module: string; readonly tab: string }
  | { readonly kind: "settings"; readonly section: string }
  | { readonly kind: "overview"; readonly module: string };

const tabs: Readonly<Record<string, readonly string[]>> = {
  budget: ["expenses", "flows", "subs"],
  loans: ["list"],
  investments: ["portfolio", "strategies", "alerts", "watchlist", "journal", "research", "review"],
  assets: [],
};

/** Resolve only native destinations that the route owner may validate and navigate to. */
export function setupActionIntent(
  moduleId: string,
  action: SetupAction,
  enabled: ReadonlySet<string>,
  cliAvailable: boolean,
):
  | { readonly kind: "navigate"; readonly target: SetupNavigation }
  | { readonly kind: "copy"; readonly text: string }
  | null {
  const kind = action.kind.toLowerCase();
  const target = action.target.trim();
  if (!target) return null;
  if (kind === "cli" || kind === "copy" || kind === "command")
    return cliAvailable ? { kind: "copy", text: target } : null;
  if (kind === "settings")
    return [
      "profile",
      "modules",
      "agent",
      "connectors",
      "data",
      "worker",
      "secrets",
      "app",
    ].includes(target)
      ? { kind: "navigate", target: { kind: "settings", section: target } }
      : null;
  if (kind !== "view" && kind !== "tab" && kind !== "navigate") return null;
  if (target === "overview")
    return { kind: "navigate", target: { kind: "overview", module: moduleId } };
  const normalized = target.replace(/^([a-z]+)[/:]([a-z]+)$/u, "$1.$2");
  const parts = normalized.split(".");
  const module = parts.length === 1 ? moduleId : parts[0];
  const tab = parts.length === 1 ? parts[0] : parts[1];
  if (!module || !tab || parts.length > 2 || !enabled.has(module) || !tabs[module]?.includes(tab))
    return null;
  return { kind: "navigate", target: { kind: "module", module, tab } };
}
