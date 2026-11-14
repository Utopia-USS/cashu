import { type CoreRegistry, withDependencies } from "@cashu/domain/core";

/** Enabling takes the registry's recursive closure; disabling removes every dependent. */
export function toggleModuleSelection(
  registry: CoreRegistry,
  selected: readonly string[],
  id: string,
): string[] {
  const spec = registry.modules.get(id);
  if (!spec?.available) return [...selected];
  if (!selected.includes(id)) return withDependencies(registry, [...selected, id]);
  const keep = new Set(selected.filter((value) => value !== id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const value of keep) {
      const dependency = registry.modules.get(value)?.dependsOn ?? [];
      if (dependency.some((dep) => !keep.has(dep))) {
        keep.delete(value);
        changed = true;
      }
    }
  }
  return [...registry.modules.keys()].filter((value) => keep.has(value));
}
