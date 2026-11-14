// The profile sheet's hook: this device's profiles (from the services, read at boot), the current one,
// incognito and what waits for the owner on the Mac. Switching goes through the app's one profile switch
// (`useSwitchProfile`), which dismisses this sheet with every other one before the vault changes: no
// close after it (a `router.back()` then would pop a route of the new profile's tabs); a switch that
// fails says so in an alert, since the sheet is already gone.
// "Remove this phone" asks first (a native alert), then runs the wipe without navigating: the wipe
// unmounts the app's tree (the sheet with it) and remounts it on Today, so a close here would reach the
// navigator only after it is gone (expo-router drains navigation after the next commit). The app
// lock's switch checks the owner (Face ID / Touch ID / passcode) before it writes either way: the phone
// must prove it can unlock before it locks, and only its owner turns the lock off.
import type { ProfileRole } from "@cashu/domain/core/notifications";
import { appClockLocale, formatCalendarDate } from "@cashu/i18n/values";
import { pendingProposalsCount } from "@cashu/store/core/profile";
import { setDeviceLock } from "@cashu/store/device";
import { useCommand, useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui/native";
import Constants from "expo-constants";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { Alert } from "react-native";
import type { NotificationPermission } from "../../notifications/scheduler";
import { relayConfig } from "../../platform/relayConfig";
import { useServices } from "../../services/ServicesProvider";
import type { LockCapability } from "../../shell/auth";
import { S as L } from "../../shell/Lock.strings";
import { useProfileNames } from "../../shell/profileNames";
import { initialOf } from "../../shell/tabs";
import { useIncognito } from "../../shell/useAppEnv";
import { lockPrompt, useLockEnabled } from "../../shell/useAppLock";
import { confirmRemoveCopy } from "../../sync/confirmRemoveCopy";
import { S as Sync } from "../../sync/Sync.strings";
import { useVaultSyncStatus } from "../../sync/usePhoneSync";
import { type SyncSlot, useSyncNotice } from "../../sync/useSyncNotice";
import { localToday } from "../screenContext";
import { S } from "./Profile.strings";
import { useSwitchProfile } from "./switchProfile";

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
  /** "Pair another profile" (a build with sync set up); `first`: nothing paired yet. */
  pairing: { first: boolean } | null;
  /** Whose phone this is for the current profile (paired profiles only). */
  role: ProfileRole | null;
  /** Paired profiles this launch could not open, with the re-pair copy. */
  unavailable: { vault: string; text: string }[];
  /** "Remove this copy" of an unavailable profile failed. */
  removeFailed: boolean;
  /**
   * The current profile's sync, as Today's banner slot shows it: the paused / limit / stuck line, or the
   * removed and sync-off notices (a profile that does not open is in `unavailable` instead).
   */
  sync: SyncSlot;
  onPair(): void;
  onRoleChanged(role: ProfileRole): void;
  onRemoveCopy(vault: string): void;
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
  /** The pairing modal (no pairing row without it). */
  openPairing?(): void;
  /** Store whose phone this is for a paired profile (reopens the services: the sheet goes away). */
  saveRole?(vault: string, role: ProfileRole): Promise<void>;
  /** Remove one paired profile's copy (`forgetThisVault`). */
  removeCopy?(vault: string): Promise<void>;
  /** The default device name (the model), shown until the registry names this phone. */
  readonly deviceName?: string;
}): ProfileSheetState {
  const services = useServices();
  const { locale } = useUiEnv();
  const { profiles } = services;
  const current = useProfile();
  const status = useVaultSyncStatus(current);
  const [removeFailed, setRemoveFailed] = useState(false);
  const paired = !services.isDemo;
  const currentRole = profiles.find((p) => p.vault === current)?.role ?? null;
  const names = useProfileNames();
  const nameOf = (vault: string, fallback: string) => names.get(vault) ?? fallback;
  const currentName = nameOf(current, "");
  const slot = useSyncNotice({
    vault: current,
    profile: currentName,
    removeCopy: (vault) => args.removeCopy?.(vault) ?? Promise.resolve(),
  });
  const sync: SyncSlot = slot.notice?.kind === "needsRepair" ? { ...slot, notice: null } : slot;
  const self = status?.names?.self;
  const by = status?.names?.pairedBy?.name ?? null;
  const pending = useQuery(pendingProposalsCount);
  const incognito = useIncognito();
  const switchProfile = useSwitchProfile();
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
      name: nameOf(p.vault, p.name),
      initial: initialOf(nameOf(p.vault, p.name)),
      current: p.vault === current,
      modules: p.modules.flatMap((id) => {
        const name = MODULE_NAMES[id];
        return name === undefined ? [] : [name()];
      }),
    })),
    incognito: incognito.on,
    isSwitching: switchProfile.isPending,
    switchFailed,
    waiting: pending > 0 ? { kind: "proposals", count: pending } : { kind: "nothing" },
    notificationsOff,
    // A paired phone: its registry name and the day (and Mac) that added it; the demo says so.
    phone:
      paired && self !== undefined
        ? {
            name: self.name,
            sub: S.paired(
              formatCalendarDate(localToday(new Date(self.addedAt)), appClockLocale(locale)),
              by,
            ),
          }
        : { name: args.deviceName ?? S.thisIphone, sub: paired ? "" : S.demoData },
    pairing:
      relayConfig() === undefined || args.openPairing === undefined ? null : { first: !paired },
    role: paired ? currentRole : null,
    unavailable: services.vaults
      .unavailableVaults()
      .map((v) => ({ vault: v.vault, text: Sync.needsRepair(v.name) })),
    removeFailed,
    sync,
    onPair: () => args.openPairing?.(),
    onRoleChanged: (role) => {
      if (role === currentRole) return;
      args.saveRole?.(current, role).catch(() => Alert.alert(S.couldNotSwitch));
    },
    onRemoveCopy: (vault) =>
      confirmRemoveCopy(nameOf(vault, profiles.find((p) => p.vault === vault)?.name ?? ""), () => {
        setRemoveFailed(false);
        args.removeCopy?.(vault).catch(() => setRemoveFailed(true));
      }),
    version: Constants.expoConfig?.version ?? "",
    dev: __DEV__,
    onProfilePicked: (vault) => {
      if (vault === current) return args.close();
      setSwitchFailed(false);
      const failed = () => {
        setSwitchFailed(true);
        Alert.alert(S.couldNotSwitch);
      };
      void switchProfile.run(vault).then((outcome) => {
        if (outcome.kind !== "completed") failed();
      }, failed);
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
