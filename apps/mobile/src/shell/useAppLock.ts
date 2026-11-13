// The app lock's hooks: whether the lock is on (the device setting, else the default), and the gate's
// lock state. The gate's store is created once per mount with the setting as it is then (the boot), is
// fed by AppState and the reducer (`lockState.ts`), and prompts on its own 300 ms after it is locked
// in the foreground, so the system prompt is not raced by the app-switcher cover going away. While it
// is locked, or in the background with the lock on (it may lock on return), it holds navigation
// (`navigationHold.ts`): no deep link or notification tap opens anything until it is unlocked.
import { C } from "@cashu/i18n/core/common.strings";
import { deviceLock } from "@cashu/store/device";
import { useProfile, useQuery } from "@cashu/store-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { useServices } from "../services/ServicesProvider";
import type { Authenticator, AuthPrompt } from "./auth";
import { S as L } from "./Lock.strings";
import type { LockScreenViewProps } from "./LockScreenView";
import { dueForPrompt, initialLock, type LockEvent, type LockState, reduceLock } from "./lockState";
import { holdNavigation } from "./navigationHold";
import { initialOf } from "./tabs";

const PROMPT_DELAY_MS = 300;

/** The app lock is on: the owner's choice, else on for real vaults and off for the demo. */
export function useLockEnabled(): boolean {
  const { isDemo } = useServices();
  const { appLock } = useQuery(deviceLock);
  // TRANSITIONAL(S44): the default follows `isDemo` until every phone holds paired, real vaults.
  return appLock ?? !isDemo;
}

/** The system prompt's texts, with `message` saying what the check is for. */
export function lockPrompt(message: string): AuthPrompt {
  return { message, cancel: C.cancel, fallback: L.usePasscode };
}

interface LockStore {
  subscribe(listener: () => void): () => void;
  get(): LockState;
  setEnabled(enabled: boolean): void;
  /** Prompts unless a prompt is open; unlocks on success. */
  unlock(auth: Authenticator): Promise<void>;
}

/** AppState's status now ("unknown" before React Native reports one). */
function currentAppState(): AppStateStatus {
  const status = AppState.currentState;
  return status === "active" || status === "background" || status === "inactive"
    ? status
    : "unknown";
}

/** Navigation is held while locked, and while in the background with the lock on (it may lock on return). */
function holdsNavigation(state: LockState): boolean {
  return state.locked || (state.enabled && state.backgroundedAt !== null);
}

function createLockStore(enabled: boolean): LockStore {
  let state = reduceLock(initialLock(currentAppState()), { kind: "boot", enabled });
  const listeners = new Set<() => void>();
  let app: { remove(): void } | null = null;
  // The store's navigation hold: taken only while mounted (subscribed), so a store React throws away
  // during render never holds anything.
  let release: (() => void) | null = null;
  const syncHold = () => {
    const hold = listeners.size > 0 && holdsNavigation(state);
    if (hold && release === null) release = holdNavigation("lock");
    if (!hold && release !== null) {
      release();
      release = null;
    }
  };
  const dispatch = (event: LockEvent) => {
    state = reduceLock(state, event);
    syncHold();
    for (const listener of listeners) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      syncHold();
      if (app === null) {
        app = AppState.addEventListener("change", (to) =>
          dispatch({ kind: "appState", from: state.appState, to, at: Date.now() }),
        );
        // A change between the render that read the state and this subscription is not lost.
        const now = currentAppState();
        if (now !== state.appState)
          dispatch({ kind: "appState", from: state.appState, to: now, at: Date.now() });
      }
      return () => {
        listeners.delete(listener);
        syncHold();
        if (listeners.size > 0) return;
        app?.remove();
        app = null;
      };
    },
    get: () => state,
    setEnabled(next) {
      if (next !== state.enabled) dispatch({ kind: "setting", enabled: next });
    },
    async unlock(auth) {
      if (state.prompting) return;
      dispatch({ kind: "prompt" });
      const result = await auth
        .authenticate(lockPrompt(L.promptUnlock))
        .catch(() => "failed" as const);
      dispatch(result === "ok" ? { kind: "unlocked" } : { kind: "promptEnded", result });
    },
  };
}

export interface AppLock extends LockScreenViewProps {
  locked: boolean;
}

export function useAppLock(): AppLock {
  const { auth, profiles } = useServices();
  const vault = useProfile();
  const enabled = useLockEnabled();
  const [store] = useState(() => createLockStore(enabled));
  const state = useSyncExternalStore(store.subscribe, store.get, store.get);
  useEffect(() => store.setEnabled(enabled), [store, enabled]);
  const due = dueForPrompt(state);
  useEffect(() => {
    if (!due) return;
    const timer = setTimeout(() => void store.unlock(auth), PROMPT_DELAY_MS);
    return () => clearTimeout(timer);
  }, [due, store, auth]);
  const name = profiles.find((p) => p.vault === vault)?.name;
  return {
    locked: state.locked,
    initial: name === undefined ? null : initialOf(name),
    failure: state.failure,
    onUnlock: () => store.unlock(auth),
  };
}
