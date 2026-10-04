// Theme override: follow the system by default; Settings can force light/dark
// by setting data-theme on <html> (tokens are repeated for it in index.css).
import { useEffect, useState } from "react";

export type ThemePref = "system" | "light" | "dark";
const KEY = "finanse.theme";

export function readTheme(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

export function applyTheme(pref: ThemePref): void {
  const el = document.documentElement;
  if (pref === "system") delete el.dataset.theme;
  else el.dataset.theme = pref;
}

/** Effective theme right now (explicit override, else the OS setting). */
export function isDark(): boolean {
  const t = document.documentElement.dataset.theme;
  if (t) return t === "dark";
  return matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Theme preference + a version that bumps whenever the effective colours change
 * (preference or OS switch), so charts that read tokens via cssVar() can re-render. */
export function useTheme(): { pref: ThemePref; setPref: (p: ThemePref) => void; version: number } {
  const [pref, setPrefState] = useState<ThemePref>(readTheme);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => { if (!document.documentElement.dataset.theme) setVersion((v) => v + 1); };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  const setPref = (p: ThemePref) => {
    try {
      if (p === "system") localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch { /* private mode: keep it for this session only */ }
    applyTheme(p);
    setPrefState(p);
    setVersion((v) => v + 1);
  };
  return { pref, setPref, version };
}
