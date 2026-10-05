// Shell context: the active profile and navigation, shared by core pages and modules.
import { createContext, useContext } from "react";
import type { ModuleInfo, Profile, SystemInfo } from "./api";
import type { View } from "./types";

export interface Shell {
  slug: string;
  profile: Profile;
  profiles: Profile[];
  system: SystemInfo | null;
  modules: ModuleInfo[];
  view: View;
  go: (v: View) => void;
  /** Re-read /api/profiles (module states, names). */
  reloadProfiles: () => Promise<void>;
  openWizard: () => void;
  /** The page asks for the narrow frame (1120 px, header included): the minimal profile view. */
  setNarrow: (narrow: boolean) => void;
}

export const ShellContext = createContext<Shell | null>(null);

export function useShell(): Shell {
  const s = useContext(ShellContext);
  if (!s) throw new Error("useShell outside the shell");
  return s;
}

/** Slug of the active profile; every profile-scoped API call takes it. */
export const useSlug = (): string => useShell().slug;

/** View <-> path used in the URL hash (#/{slug}/{path}) and by setup actions of kind "view":
 * "overview", "<module>.<tab>", "<module>.<tab>/<sub>" (a page inside a tab, e.g.
 * "investments.portfolio/alerts" or ".../assets/306"), "setup/<module>", "settings" or "settings/<section>". */
export function viewToPath(v: View): string {
  if (v.kind === "settings") return v.section ? `settings/${v.section}` : "settings";
  if (v.kind === "setup") return `setup/${v.module}`;
  return v.sub ? `${v.tab}/${v.sub}` : v.tab;
}

export function pathToView(path: string | undefined): View | null {
  if (!path) return null;
  const [head, ...rest] = path.split("/");
  const arg = rest[0];
  if (head === "settings") return { kind: "settings", section: arg || undefined };
  if (head === "setup" && arg) return { kind: "setup", module: arg };
  if (!head) return null;
  const sub = rest.join("/");
  return sub ? { kind: "tab", tab: head, sub } : { kind: "tab", tab: head };
}
