// Device-wide app state of the shell, kept in the device store: incognito (money hidden, the eye button
// and the profile sheet's toggle) and when the app was last opened.
import { devicePhoneState, setDevicePhoneState } from "@cashu/store/device";
import { useCommand, useQuery } from "@cashu/store-react";
import { installIncognitoStore, setIncognito } from "@cashu/ui-logic/core/incognito";
import { useEffect, useEffectEvent } from "react";
import { AppState } from "react-native";

/**
 * Once at startup: the ui-logic incognito flag needs a store, but on the phone the device store is the
 * source of truth (`devicePhoneState.incognito`), so this one keeps nothing and `useIncognitoMirror`
 * copies the device value in.
 */
export function installPhoneIncognito(): void {
  installIncognitoStore({ load: () => false, save: () => {} });
}

export interface Incognito {
  readonly on: boolean;
  toggle(): void;
  readonly isPending: boolean;
}

/** Incognito from the device store; toggling writes it back (`setDevicePhoneState`). */
export function useIncognito(): Incognito {
  const { incognito } = useQuery(devicePhoneState);
  const write = useCommand(setDevicePhoneState);
  return {
    on: incognito,
    toggle: () => void write.run({ incognito: !incognito }),
    isPending: write.isPending,
  };
}

/** Keeps the ui-logic flag (plain formatters) equal to the device store's incognito. */
export function useIncognitoMirror(on: boolean): void {
  useEffect(() => setIncognito(on), [on]);
}

/** When the app was opened before this session's last open (undefined: not read yet). */
let previousOpenedAt: string | null | undefined;

/** The previous open time, read before this open was written ("since last open"). */
export function lastOpenedBefore(): string | null {
  return previousOpenedAt ?? null;
}

/**
 * On start and on every return from the background: remember the previous open, then stamp now. An
 * `inactive -> active` (Control Center, the notification shade, Face ID, a call banner) is not an open.
 */
export function useLastOpened(): void {
  const { lastOpenedAt } = useQuery(devicePhoneState);
  const write = useCommand(setDevicePhoneState);
  const opened = useEffectEvent(() => {
    previousOpenedAt = lastOpenedAt;
    void write.run({ lastOpenedAt: new Date().toISOString() });
  });
  useEffect(() => {
    opened();
    let previous: string | null | undefined = AppState.currentState;
    const subscription = AppState.addEventListener("change", (state) => {
      if (previous === "background" && state === "active") opened();
      previous = state;
    });
    return () => subscription.remove();
  }, []);
}
