// Small hooks of the investments workspace: per-profile remembered values and the workspace
// keyboard shortcuts. (Undo of saved changes: undo.ts, F5 R4.)
import { useCallback, useEffect, useRef, useState } from "react";

const read = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, v: string | null) => {
  try { if (v == null) localStorage.removeItem(key); else localStorage.setItem(key, v); } catch { /* private mode */ }
};

/** A value remembered in localStorage under a profile-scoped key (`finanse.inv.<name>.<slug>`).
 * The key includes the slug, so another profile never sees it. */
export function useStored<T>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = read(key);
    if (raw == null) return initial;
    try { return JSON.parse(raw) as T; } catch { return initial; }
  });
  const set = useCallback((v: T) => { setValue(v); write(key, v == null ? null : JSON.stringify(v)); }, [key]);
  return [value, set];
}

export const storedKey = (name: string, slug: string) => `finanse.inv.${name}.${slug}`;

/** Workspace shortcuts (r, i, j, k, Enter). Ignored while typing in a field or with a modifier,
 * and while a drawer / dialog is open (Esc is handled by those). */
export function useShortcuts(map: Record<string, () => void>, enabled = true) {
  const ref = useRef(map);
  ref.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "Enter" && t && /^(BUTTON|A|SUMMARY)$/.test(t.tagName)) return; // native activation
      if (document.querySelector(".drawer, .adrawer, .overlay, .pop, .menu")) return;
      const fn = ref.current[e.key];
      if (fn) { e.preventDefault(); fn(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
