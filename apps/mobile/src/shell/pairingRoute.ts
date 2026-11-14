// First-run routing to the pairing modal: a build with sync set up whose phone holds no paired profile
// (only the demo) opens the pairing modal once per launch; closing it shows the demo as before. A
// pairing whose vault was just added continues there after the services reopened (the root remounted
// its tree, the modal with it): role and first sync.
import { type Href, useRouter } from "expo-router";
import { useEffect } from "react";
import { relayConfig } from "../platform/relayConfig";
import { pairingContinues } from "../screens/pair/pairFlow";
import { useServices } from "../services/ServicesProvider";

/** Whether the shell opens the pairing modal now (pure). */
export function shouldOpenPairing(input: {
  readonly syncBuild: boolean;
  /** Every vault on the phone is a demo vault. */
  readonly onlyDemo: boolean;
  /** The first-run modal was opened already this launch. */
  readonly shownThisLaunch: boolean;
  /** A pairing's role / first-sync steps wait (`pairingContinues`). */
  readonly continues: boolean;
}): boolean {
  if (input.continues) return true;
  return input.syncBuild && input.onlyDemo && !input.shownThisLaunch;
}

let shownThisLaunch = false;

/** The modal's route (typed routes list it once the dev server regenerated them). */
const PAIR_ROUTE = "/modal/pair" as Href;

/**
 * Opens the pairing modal when `shouldOpenPairing` says so, on the next macrotask after the root
 * mounted (the root stack is mounted by then).
 */
export function usePairingRoute(): void {
  const router = useRouter();
  const services = useServices();
  useEffect(() => {
    const open = shouldOpenPairing({
      syncBuild: relayConfig() !== undefined,
      onlyDemo: services.isDemo,
      shownThisLaunch,
      continues: pairingContinues(),
    });
    if (!open) return;
    const timer = setTimeout(() => {
      shownThisLaunch = true;
      router.push(PAIR_ROUTE);
    }, 0);
    return () => clearTimeout(timer);
  }, [router, services]);
}
