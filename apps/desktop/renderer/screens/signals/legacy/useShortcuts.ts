// ab24ab6 modules/investments/hooks.ts useShortcuts: single-key shortcuts on the document while `enabled`; never
// while typing in a field, never on Enter over a button or link (their own activation), never with a modifier.
import { useEffect, useRef } from "react";

export function useShortcuts(map: Record<string, () => void>, enabled = true) {
  const ref = useRef(map);
  useEffect(() => {
    ref.current = map;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      if (e.key === "Enter" && t && /^(BUTTON|A|SUMMARY)$/.test(t.tagName)) return;
      const fn = ref.current[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [enabled]);
}
