// Replays the deep link kept by `app/+native-intent.ts` (`heldLinks.ts`) once navigation is free: never
// while the app lock holds it, and not before the start route ("/") has gone on to Today, so the link
// lands on top of Today instead of being replaced by the start's redirect. Mounted in the lock gate,
// after the lock's own hook, so on a cold start the lock's hold is taken before the replay waits.
import { type Href, usePathname, useRouter } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import { pendingLink, subscribePendingLink, takePendingLink } from "./heldLinks";
import { isNavigationHeld, subscribeNavigationHold, whenNavigationFree } from "./navigationHold";

export function useHeldLinkReplay(): void {
  const router = useRouter();
  const pathname = usePathname();
  const held = useSyncExternalStore(subscribeNavigationHold, isNavigationHeld, isNavigationHeld);
  const link = useSyncExternalStore(subscribePendingLink, pendingLink, pendingLink);
  useEffect(() => {
    if (held || link === null || pathname === "/") return;
    let live = true;
    void whenNavigationFree().then(() => {
      if (!live) return;
      const path = takePendingLink();
      if (path !== null) router.push(path as Href);
    });
    return () => {
      live = false;
    };
  }, [held, link, pathname, router]);
}
