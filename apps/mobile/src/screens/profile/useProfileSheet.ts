// The profile sheet's hook: this device's profiles (from the services, read at boot), the current one,
// incognito and what waits for the owner on the Mac. Switching runs the device command and closes.
// "Remove this phone" asks first (a native alert), then runs the wipe without navigating: the wipe
// unmounts the app's tree (the sheet with it) and remounts it on Today, so a close here would reach the
// navigator only after it is gone (expo-router drains navigation after the next commit). The app
// lock's switch checks the owner (Face ID / Touch ID / passcode) before it writes either way: the phone
// must prove it can unlock before it locks, and only its owner turns the lock off.
import { pendingProposalsCount } from "@cashu/store/core/profile";
import { setCurrentVault, setDeviceLock } from "@cashu/store/device";
import { useCommand, useProfile, useQuery } from "@cashu/store-react";
import Constants from "expo-constants";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert } from "react-native";
import type { NotificationPermission } from "../../notifications/scheduler";
import { useServices } from "../../services/ServicesProvider";
import type { LockCapability } from "../../shell/auth";
import { S as L } from "../../shell/Lock.strings";
import { initialOf } from "../../shell/tabs";
import { useIncognito } from "../../shell/useAppEnv";
import { lockPrompt, useLockEnabled } from "../../shell/useAppLock";
import { S } from "./Profile.strings";

export type ProfileSheetState = {
  kind: "ready";
  profiles: {
    vault: string;
    name: string;
    initial: string;
    current: boolean;
    modules: string[];
  }[];
  incognito: boolean;
  isSwitching: boolean;
  /** The last switch was refused or failed; the sheet stays open and says so. */
  switchFailed: boolean;
  waiting: { kind: "nothing" } | { kind: "proposals"; count: number };
  /** iOS Settings turned cashU's notifications off: the Notifications row says so. */
  notificationsOff: boolean;
  /** This phone's line above "Remove this phone". */
  phone: { name: string; sub: string };
  version: string;
  dev: boolean;
  onProfilePicked(vault: string): void;
  onIncognitoToggle(): void;
  /** The app lock: on or off, what the phone checks with (null until known), a check or write running. */
  lock: { enabled: boolean; capability: LockCapability | null; isPending: boolean };
  /** Checks the owner first; writes only after a successful check (a cancel changes nothing). */
  onLockToggle(on: boolean): void;
  /** Asks to confirm; on confirm removes this phone's copy (the wipe's remount closes the sheet). */
  onRemovePhone(): void;
  onNotifications(): void;
  onDiagnostics(): void;
  onBench(): void;
  onClose(): void;
};

const MODULE_NAMES: Readonly<Record<string, () => string>> = {
  budget: () => S.moduleBudget,
  assets: () => S.moduleAssets,
  loans: () => S.moduleLoans,
  investments: () => S.moduleInvestments,
};

export function useProfileSheet(args: {
  close(): void;
  /** The notifications settings (pushed in the Today stack). */
  openNotifications(): void;
  /** The iOS notification permission (the route binds the scheduler's); unknown when absent. */
  notificationPermission?(): Promise<NotificationPermission>;
  openDiagnostics(): void;
  openBench(): void;
  /**
   * Delete everything on this phone and rebuild (the route binds `wipeThisPhone`). Called with no
   * navigation before it: the wipe replaces the whole tree, the sheet included.
   */
  removePhone(): Promise<void>;
}): ProfileSheetState {
  const { profiles } = useServices();
  const current = useProfile();
  const pending = useQuery(pendingProposalsCount);
  const incognito = useIncognito();
  const switchVault = useCommand(setCurrentVault);
  const [switchFailed, setSwitchFailed] = useState(false);
  const lock = useLockSwitch();
  const [notificationsOff, setNotificationsOff] = useState(false);
  const readPermission = useEffectEvent(() => {
    args.notificationPermission?.().then(
      (state) => setNotificationsOff(state === "denied"),
      () => undefined,
    );
  });
  // Read once per sheet: the sheet is short-lived, and the settings screen reads it again on return.
  useEffect(() => readPermission(), []);
  return {
    kind: "ready",
    profiles: profiles.map((p) => ({
      vault: p.vault,
      name: p.name,
      initial: initialOf(p.name),
      current: p.vault === current,
      modules: p.modules.flatMap((id) => {
        const name = MODULE_NAMES[id];
        return name === undefined ? [] : [name()];
      }),
    })),
    incognito: incognito.on,
    isSwitching: switchVault.isPending,
    switchFailed,
    waiting: pending > 0 ? { kind: "proposals", count: pending } : { kind: "nothing" },
    notificationsOff,
    // TRANSITIONAL(S44): the phone has no device registry yet; a paired phone shows its name and the
    // day it was added.
    phone: { name: S.thisIphone, sub: S.demoData },
    version: Constants.expoConfig?.version ?? "",
    dev: __DEV__,
    onProfilePicked: (vault) => {
      if (vault === current) return args.close();
      setSwitchFailed(false);
      void switchVault.run({ vault }).then(
        (outcome) => {
          if (outcome.kind === "completed") args.close();
          else setSwitchFailed(true);
        },
        () => setSwitchFailed(true),
      );
    },
    onIncognitoToggle: incognito.toggle,
    lock: lock.state,
    onLockToggle: lock.toggle,
    onRemovePhone: () =>
      Alert.alert(S.removeTitle, S.removeBody, [
        { text: S.cancel, style: "cancel" },
        {
          text: S.remove,
          style: "destructive",
          onPress: () => {
            args.removePhone().catch(() => Alert.alert(S.removeFailed));
          },
        },
      ]),
    onNotifications: args.openNotifications,
    onDiagnostics: args.openDiagnostics,
    onBench: args.openBench,
    onClose: args.close,
  };
}

/** The app lock's switch: the setting, the phone's capability (read once per sheet), check-then-write. */
function useLockSwitch(): {
  state: ProfileSheetState["lock"];
  toggle(on: boolean): void;
} {
  const { auth } = useServices();
  const enabled = useLockEnabled();
  const write = useCommand(setDeviceLock);
  const [capability, setCapability] = useState<LockCapability | null>(null);
  const [checking, setChecking] = useState(false);
  // Set before the prompt starts: two taps before the next render start one check, not two.
  const inFlight = useRef(false);
  useEffect(() => {
    let live = true;
    // `capability()` never rejects (the port's contract).
    void auth.capability().then((found) => {
      if (live) setCapability(found);
    });
    return () => {
      live = false;
    };
  }, [auth]);
  return {
    state: { enabled, capability, isPending: checking || write.isPending },
    toggle: (on) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setChecking(true);
      void auth
        .authenticate(lockPrompt(on ? L.promptLockOn : L.promptLockOff))
        .then(async (result) => {
          if (result === "ok") await write.run({ appLock: on });
        })
        // A refused write leaves the switch where it was, which is what the setting still says.
        .catch(() => {})
        .finally(() => {
          inFlight.current = false;
          setChecking(false);
        });
    },
  };
}
