// The running app's sync triggers (mounted once by `PhoneSync`): a pass for every synced vault after the
// first frame, a pass on the return from the background (the runner keeps 30 s between two), and a
// push-only pass on the arrival in the background when own writes wait (iOS gives the app a few
// seconds there). A Control Center pull or a Face ID prompt (`inactive`) is not a trigger. Also the
// read side for the screens: one vault's sync status, live (`syncCause` names why it is behind).
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { useServices } from "../services/ServicesProvider";
import type { VaultSyncStatus } from "../services/vaultEngine";

export function usePhoneSync(): void {
  const services = useServices();
  useEffect(() => {
    const runner = services.sync;
    const first = setTimeout(() => void runner.request("start"), 0);
    let previous = AppState.currentState;
    const appState = AppState.addEventListener("change", (state) => {
      if (state === "active" && previous === "background") void runner.request("foreground");
      if (state === "background" && previous !== "background") void runner.request("background");
      previous = state;
    });
    return () => {
      clearTimeout(first);
      appState.remove();
    };
  }, [services]);
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * One vault's sync status, live; a paired vault whose files did not open this launch reads `failed` /
 * `needs_repair`; undefined for a vault this phone does not hold.
 */
export function useVaultSyncStatus(vault: string): VaultSyncStatus | undefined {
  const vaults = useServices().vaults;
  const session = vaults.get(vault);
  return useSyncExternalStore(session === undefined ? NO_SUBSCRIPTION : session.subscribe, () =>
    session === undefined ? vaults.unavailable(vault) : session.status(),
  );
}
