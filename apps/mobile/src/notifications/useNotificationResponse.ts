// A tap on one of this phone's notifications: switch to its profile when it is the other one, then
// open its screen (`taps.ts`). The switch is the app's one profile switch (`useSwitchProfile`): every
// sheet and modal of the previous profile is dismissed before the vault changes. On a cold start from a
// tap the hook runs before the root navigator is ready, so it waits for three things first: the root
// navigation state (expo-router refuses or drops a navigation before it), the start route's redirect to
// Today (a link pushed before it would be replaced), and a free navigation (`navigationHold.ts`: never
// under the app lock). The tap is cleared only once it was handled, so a tap that had to wait is not lost.
import { useProfile } from "@cashu/store-react";
import { usePathname, useRootNavigationState, useRouter } from "expo-router";
import { useEffect, useEffectEvent, useRef, useSyncExternalStore } from "react";
import { clearNotificationTap, useNotificationTap } from "../platform/notifications";
import { useSwitchProfile } from "../screens/profile/switchProfile";
import { useServices } from "../services/ServicesProvider";
import {
  isNavigationHeld,
  subscribeNavigationHold,
  whenNavigationFree,
} from "../shell/navigationHold";
import { type TapDestination, tapTarget } from "./taps";

/**
 * Resolves once no hold is taken, checked again after each wait: on a cold start the lock takes its
 * hold in the same commit that made navigation ready, after this hook's effect.
 */
async function navigationFree(): Promise<void> {
  await whenNavigationFree();
  while (isNavigationHeld()) await whenNavigationFree();
}

export function useNotificationResponse(): void {
  const tap = useNotificationTap();
  const { profiles } = useServices();
  const current = useProfile();
  const switchProfile = useSwitchProfile();
  const router = useRouter();
  const ready = useRootNavigationState()?.key !== undefined;
  const started = usePathname() !== "/";
  const held = useSyncExternalStore(subscribeNavigationHold, isNavigationHeld, isNavigationHeld);
  const handled = useRef<string | null>(null);

  const open = (destination: TapDestination) => {
    switch (destination.kind) {
      case "signals":
        return router.navigate({ pathname: "/(tabs)/investments", params: { view: "signals" } });
      case "today":
        return router.navigate("/(tabs)/today");
      case "closed":
        return router.push(
          destination.month === null
            ? "/(tabs)/today/closed"
            : { pathname: "/(tabs)/today/closed", params: { month: destination.month } },
        );
      case "profile":
        return router.push("/sheet/profile");
    }
  };
  const handle = useEffectEvent(async () => {
    const pressed = tap;
    // Once per tap, however often the conditions flip while a profile switch is in flight.
    if (pressed === null || handled.current === pressed.key) return;
    handled.current = pressed.key;
    const target = tapTarget(
      pressed.data,
      profiles.map((p) => p.vault),
      current,
    );
    if (target !== null) {
      const { switchTo, destination } = target;
      if (switchTo === null) open(destination);
      else if ((await switchProfile.run(switchTo)).kind === "completed") open(destination);
    }
    clearNotificationTap();
  });
  const key = tap?.key ?? null;
  useEffect(() => {
    if (key === null || !ready || !started || held) return;
    let live = true;
    void navigationFree().then(() => {
      if (live) void handle();
    });
    return () => {
      live = false;
    };
  }, [key, ready, started, held]);
}
