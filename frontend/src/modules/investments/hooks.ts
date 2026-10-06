// Small hooks of the investments workspace: per-profile remembered values and the workspace
// keyboard shortcuts. (Undo of saved changes: undo.ts, F5 R4.)
import { useCallback, useEffect, useRef, useState } from "react";
import { readStored } from "../../core/storage.ts";

type Where = "local" | "session";
const store = (where: Where): Storage | null => { try { return where === "session" ? sessionStorage : localStorage; } catch { return null; } };
const read = (key: string, where: Where = "local"): string | null => { try { return readStored(store(where), key); } catch { return null; } };
const write = (key: string, v: string | null, where: Where = "local") => {
  try { const s = store(where); if (v == null) s?.removeItem(key); else s?.setItem(key, v); } catch { /* private mode */ }
};

/** A value remembered under a profile-scoped key (`cashu.inv.<name>.<slug>`); the key includes the slug,
 * so another profile never sees it. `session`: this window only (free text that may hold amounts, F7 PK8:
 * the desktop WebView keeps localStorage outside the data dir). */
export function useStored<T>(key: string, initial: T, where: Where = "local"): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const raw = read(key, where);
    if (raw == null) return initial;
    try { return JSON.parse(raw) as T; } catch { return initial; }
  });
  const set = useCallback((v: T) => { setValue(v); write(key, v == null ? null : JSON.stringify(v), where); }, [key, where]);
  return [value, set];
}

export const storedKey = (name: string, slug: string) => `cashu.inv.${name}.${slug}`;

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
