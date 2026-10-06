// "Stop reminding me" of a module that is not set up yet: one store for the Przegląd ghost card (PendingWidget)
// and the partial-setup strip on the module's first tab (design/v3/first-steps section 12). The key is
// `<slug>.<module>` and the value the setup state it was hidden in: a new state shows the reminder again.
// Browser storage is a convenience only (it may be unavailable): every read and write is guarded.
import { readStored } from "./storage.ts";

export const HIDDEN_KEY = "cashu.hiddenCards";

const listeners = new Set<() => void>();
/** This window's hides: they hold while storage is unavailable (private window, blocked site data). */
const memory: Record<string, string> = {};

/** Every hidden reminder: `{ "<slug>.<module>": "<state>" }`. */
export function hiddenCards(): Record<string, string> {
  try {
    const v = JSON.parse(readStored(globalThis.localStorage, HIDDEN_KEY) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? { ...v, ...memory } : { ...memory };
  } catch {
    return { ...memory };
  }
}

/** The module's reminder is hidden for this setup state. */
export const isHidden = (slug: string, id: string, state: string): boolean => hiddenCards()[`${slug}.${id}`] === state;

/** Hide the module's reminder until its setup state changes; subscribers re-render. */
export function hideCard(slug: string, id: string, state: string): void {
  memory[`${slug}.${id}`] = state;
  const next = hiddenCards();
  try { globalThis.localStorage?.setItem(HIDDEN_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  listeners.forEach((l) => l());
}

/** Re-render on a hide made elsewhere in this window. Returns the unsubscribe. */
export function onHiddenChange(l: () => void): () => void {
  listeners.add(l);
  return () => { listeners.delete(l); };
}
