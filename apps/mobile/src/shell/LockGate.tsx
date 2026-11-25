// The app lock's gate around the whole app: the app always renders underneath (no state is lost, nothing
// remounts); while locked, the lock screen covers it above every sheet and modal (`AboveAll`) and the
// app underneath is hidden from VoiceOver (props on one wrapping view, so nothing remounts). Navigation
// is held while locked (`useAppLock`), and a deep link kept meanwhile is replayed after the unlock.
//
// `FullWindowOverlay` attaches its layer to the window once, when it mounts; a sheet or modal presented
// later is added to the same window above it. So while locked the overlay is keyed by the route: a
// route change remounts it, which attaches it again on top, and once more shortly after, when the
// presentation's own views are in the window.
import { usePathname } from "expo-router";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { AboveAll } from "./AboveAll";
import { LockScreenView } from "./LockScreenView";
import { useAppLock } from "./useAppLock";
import { useHeldLinkReplay } from "./useHeldLinkReplay";

/** After a route change while locked, the overlay is attached once more after this delay. */
const RAISE_AGAIN_MS = 400;

export function LockGate({ children }: { children: ReactNode }) {
  const { locked, ...screen } = useAppLock();
  useHeldLinkReplay();
  const overlayKey = useOverlayKey(locked);
  return (
    <>
      <View
        className="flex-1"
        accessibilityElementsHidden={locked}
        importantForAccessibility={locked ? "no-hide-descendants" : "auto"}
      >
        {children}
      </View>
      {locked && (
        <AboveAll key={overlayKey}>
          <LockScreenView {...screen} />
        </AboveAll>
      )}
    </>
  );
}

/** The overlay's key: the route, plus a raise shortly after the route changed while locked. */
function useOverlayKey(locked: boolean): string {
  const pathname = usePathname();
  const [raised, setRaised] = useState(0);
  const seen = useRef(pathname);
  useEffect(() => {
    if (seen.current === pathname) return;
    seen.current = pathname;
    if (!locked) return;
    const timer = setTimeout(() => setRaised((n) => n + 1), RAISE_AGAIN_MS);
    return () => clearTimeout(timer);
  }, [locked, pathname]);
  return `${pathname}#${raised}`;
}
