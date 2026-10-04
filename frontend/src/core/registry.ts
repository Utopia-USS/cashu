// Frontend module registry, in navigation order (Przegląd | budget | Kredyty | Majątek | Inwestycje).
// A backend module without a frontend half still gets a tab with its SetupPage.
import { assets } from "../modules/assets";
import { budget } from "../modules/budget";
import { investments } from "../modules/investments";
import { loans } from "../modules/loans";
import type { ModuleInfo } from "./api";
import type { ModuleDef } from "./types";

export const MODULES: ModuleDef[] = [budget, loans, assets, investments];

const generic = (info: ModuleInfo): ModuleDef => ({
  id: info.id,
  name: info.name || info.id,
  desc: info.description,
  short: info.description,
  intro: info.description,
  tabs: [{ id: "main", label: info.name || info.id, render: () => null }],
});

export function moduleDef(id: string, infos: ModuleInfo[] = []): ModuleDef {
  const known = MODULES.find((m) => m.id === id);
  if (known) return known;
  const info = infos.find((m) => m.id === id) ?? { id, name: id, description: "", depends_on: [], available: true };
  return generic(info);
}

/** Order module ids: registry order first, unknown ones after in their given order. */
export function orderModules<T extends { id: string }>(items: T[]): T[] {
  const rank = (id: string) => {
    const i = MODULES.findIndex((m) => m.id === id);
    return i < 0 ? MODULES.length : i;
  };
  return items.map((m, i) => ({ m, i })).sort((a, b) => rank(a.m.id) - rank(b.m.id) || a.i - b.i).map(({ m }) => m);
}

export const tabKey = (moduleId: string, tabId: string) => `${moduleId}.${tabId}`;
