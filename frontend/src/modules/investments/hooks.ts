// Small hooks of the investments workspace: per-profile remembered values, deferred commits with
// undo, and the workspace keyboard shortcuts.
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

/** Commit-after-delay with undo (the "Cofnij" in a toast): `schedule(fn)` runs `fn` after `ms`
 * unless cancelled; pending work is flushed (run now) when the component unmounts or the page is
 * hidden, so a decision is never lost by navigating away. Returns `schedule` and `flush`. */
export function useDeferred(ms = 6000) {
  const pending = useRef(new Map<number, { fn: () => void; timer: ReturnType<typeof setTimeout> }>());
  const seq = useRef(0);
  const flush = useCallback(() => {
    for (const [id, p] of pending.current) { clearTimeout(p.timer); pending.current.delete(id); p.fn(); }
  }, []);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") flush(); };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onHide);
      flush();
    };
  }, [flush]);
  const schedule = useCallback((fn: () => void): (() => boolean) => {
    const id = ++seq.current;
    const timer = setTimeout(() => { pending.current.delete(id); fn(); }, ms);
    pending.current.set(id, { fn, timer });
    return () => {
      const p = pending.current.get(id);
      if (!p) return false;
      clearTimeout(p.timer);
      pending.current.delete(id);
      return true;
    };
  }, [ms]);
  return { schedule, flush };
}

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
      if (document.querySelector(".drawer, .overlay, .pop, .menu")) return;
      const fn = ref.current[e.key];
      if (fn) { e.preventDefault(); fn(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
