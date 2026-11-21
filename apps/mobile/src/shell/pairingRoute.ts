// First-run routing to the pairing modal: a build with sync set up whose phone holds no paired profile
// (only the demo) opens the pairing modal once per launch; closing it shows the demo as before. A
// pairing past its commit point continues there after the services reopened over the new vault (the
// root remounted its tree, the modal with it): storing, role and first sync. The flow's state is read
// live, not once at mount: the reopen remounts the tree while the flow is still storing, and the role
// step arrives after the remount. Nothing is presented while navigation is held (the app lock): the
// modal comes back on the flow's step right after the unlock.
import { type Href, usePathname, useRouter } from "expo-router";
import { useEffect, useSyncExternalStore } from "react";
import { relayConfig } from "../platform/relayConfig";
import { pairFlow, pairingContinues } from "../screens/pair/pairFlow";
import { useServices } from "../services/ServicesProvider";
import { isNavigationHeld, subscribeNavigationHold } from "./navigationHold";

/** Whether the shell opens the pairing modal now (pure). */
export function shouldOpenPairing(input: {
  readonly syncBuild: boolean;
  /** Every vault on the phone is a demo vault. */
  readonly onlyDemo: boolean;
  /** The first-run modal was opened already this launch. */
  readonly shownThisLaunch: boolean;
  /** A pairing's storing / role / first-sync steps wait (`pairingContinues`). */
  readonly continues: boolean;
  /** The pairing modal is the current route. */
  readonly presented?: boolean;
}): boolean {
  if (input.presented === true) return false;
  if (input.continues) return true;
  return input.syncBuild && input.onlyDemo && !input.shownThisLaunch;
}

let shownThisLaunch = false;

/** The modal's route (typed routes list it once the dev server regenerated them). */
const PAIR_ROUTE = "/modal/pair" as Href;
const PAIR_PATH = "/modal/pair";

/**
 * Opens the pairing modal when `shouldOpenPairing` says so, on the next macrotask, once the start route
 * ("/") went on to Today and navigation is free.
 */
export function usePairingRoute(): void {
  const router = useRouter();
  const pathname = usePathname();
  const services = useServices();
  const continues = useSyncExternalStore(pairFlow.subscribe, pairingContinues, pairingContinues);
  const held = useSyncExternalStore(subscribeNavigationHold, isNavigationHeld, isNavigationHeld);
  useEffect(() => {
    if (held || pathname === "/") return;
    const open = shouldOpenPairing({
      syncBuild: relayConfig() !== undefined,
      onlyDemo: services.isDemo,
      shownThisLaunch,
      continues,
      presented: pathname === PAIR_PATH,
    });
    if (!open) return;
    const timer = setTimeout(() => {
      shownThisLaunch = true;
      router.push(PAIR_ROUTE);
    }, 0);
    return () => clearTimeout(timer);
  }, [router, services, continues, held, pathname]);
}
