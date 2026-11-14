// The pairing's hold over the services' reopen: once the pairing passed its commit point the services
// reopen over the new vault, the root remounts and starts at Today, and the shell presents the modal
// again (`pairingRoute`). Until that modal is presented (its transition ended), the "Saving on this
// phone..." step stays drawn above everything, so neither the gap of the reopen nor the new profile's
// empty Today shows in between. Never over the app lock (navigation held): the lock screen covers then,
// and the modal comes back after the unlock.
import { useEffect, useSyncExternalStore } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PairView } from "../screens/pair/PairView";
import { pairFlow, pairingContinues } from "../screens/pair/pairFlow";
import { AboveAll } from "./AboveAll";
import { isNavigationHeld, subscribeNavigationHold } from "./navigationHold";

let presented = false;
const listeners = new Set<() => void>();
const subscribePresented = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const isPresented = () => presented;
function setPresented(value: boolean): void {
  if (presented === value) return;
  presented = value;
  for (const listener of [...listeners]) listener();
}

/** Whether the hold is drawn (pure). */
function holdsForPairing(input: {
  /** A pairing's storing / role / first-sync steps wait (`pairingContinues`). */
  readonly continues: boolean;
  /** The pairing modal is on screen (its presentation ended). */
  readonly modalPresented: boolean;
  /** Navigation is held (the app lock). */
  readonly held: boolean;
}): boolean {
  return input.continues && !input.modalPresented && !input.held;
}

/** The pairing modal says it is on screen while `shown` holds and it is mounted. */
export function usePairingModalPresented(shown: boolean): void {
  useEffect(() => {
    if (!shown) return;
    setPresented(true);
    return () => setPresented(false);
  }, [shown]);
}

/** The hold; `inWindow` false draws it in place (the root's opening phase, when nothing else is drawn). */
export function PairingHold({ inWindow = true }: { inWindow?: boolean }) {
  const continues = useSyncExternalStore(pairFlow.subscribe, pairingContinues, pairingContinues);
  const modalPresented = useSyncExternalStore(subscribePresented, isPresented, isPresented);
  const held = useSyncExternalStore(subscribeNavigationHold, isNavigationHeld, isNavigationHeld);
  if (!holdsForPairing({ continues, modalPresented, held })) return null;
  return inWindow ? (
    <AboveAll>
      <StoringStep />
    </AboveAll>
  ) : (
    <StoringStep />
  );
}

/** The storing step as the modal draws it (inside the safe area). */
function StoringStep() {
  const insets = useSafeAreaInsets();
  return (
    <View
      testID="pairing-hold"
      className="absolute inset-0 bg-surface"
      style={{ paddingTop: insets.top, paddingBottom: insets.bottom }}
    >
      <PairView kind="storing" />
    </View>
  );
}
