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
 * "overview", "<module>.<tab>", "setup/<module>", "settings" or "settings/<section>". */
export function viewToPath(v: View): string {
  if (v.kind === "settings") return v.section ? `settings/${v.section}` : "settings";
  if (v.kind === "setup") return `setup/${v.module}`;
  return v.tab;
}

export function pathToView(path: string | undefined): View | null {
  if (!path) return null;
  const [head, arg] = path.split("/");
  if (head === "settings") return { kind: "settings", section: arg || undefined };
  if (head === "setup" && arg) return { kind: "setup", module: arg };
  return head ? { kind: "tab", tab: head } : null;
}
