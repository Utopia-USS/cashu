// The header's incognito toggle: an eye that hides absolute amounts (percentages stay). The flag and the masking
// live in src/incognito.ts; the shell remounts the page on a change.
import { useSyncExternalStore } from "react";
import { isIncognito, onIncognitoChange, setIncognito } from "../incognito";
import { S } from "./chrome.strings.ts";

export const useIncognito = (): boolean => useSyncExternalStore(onIncognitoChange, isIncognito);

export function IncognitoToggle() {
  const on = useIncognito();
  const title = on ? S.showAmounts : S.hideAmounts;
  return (
    <button className={`btn incog ${on ? "on" : ""}`} onClick={() => setIncognito(!on)}
      title={title} aria-label={title} aria-pressed={on}>
      <svg viewBox="0 0 16 16" aria-hidden>
        <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
        <circle cx="8" cy="8" r="2" />
        {on && <path d="M2.5 13.5l11-11" />}
      </svg>
    </button>
  );
}
