// Test helpers for app-update scenarios (events.md 7.9): the builtin modules with one component's
// version bumped, as the next app release would ship them. Synthetic only.
import type { StoreModule } from "../registry.js";

/** `modules` with the materializer, identity kind or deriver `id` at version + 1. */
export function bumpVersion(modules: readonly StoreModule[], id: string): StoreModule[] {
  let found = false;
  const bump = <T extends { readonly id: string; readonly version: number }>(x: T): T => {
    if (x.id !== id) return x;
    found = true;
    return { ...x, version: x.version + 1 };
  };
  const out = modules.map((m) => ({
    ...m,
    materializers: m.materializers.map(bump),
    ...(m.identityKinds ? { identityKinds: m.identityKinds.map(bump) } : {}),
    ...(m.derivers ? { derivers: m.derivers.map(bump) } : {}),
  }));
  if (!found) throw new RangeError(`no component ${id}`);
  return out;
}
