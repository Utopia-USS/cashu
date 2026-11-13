// The app lock's state (pure, tested in Node). With the lock on, the app starts locked and locks again
// when it comes back after at least `LOCK_AFTER_MS` in the background. An `inactive` spell never locks:
// the Face ID prompt itself, the app switcher, Control Center and a call banner all pass through it.
// The lock gate prompts once on its own each time it is locked in the foreground; after that the
// lock screen's Unlock button prompts again.
import type { AppStateStatus } from "react-native";
import type { AuthResult } from "./auth";

export const LOCK_AFTER_MS = 30_000;

export type LockEvent =
  | { kind: "boot"; enabled: boolean }
  | { kind: "appState"; from: AppStateStatus; to: AppStateStatus; at: number }
  | { kind: "unlocked" }
  | { kind: "setting"; enabled: boolean }
  /** A prompt started (the automatic one or the Unlock button). */
  | { kind: "prompt" }
  /** A prompt ended without unlocking (an "ok" is `unlocked`). */
  | { kind: "promptEnded"; result: Exclude<AuthResult, "ok"> };

export interface LockState {
  enabled: boolean;
  locked: boolean;
  /** When the app went to the background (null while it is in the foreground). */
  backgroundedAt: number | null;
  /** A prompt is open: nothing prompts again until it ends. */
  prompting: boolean;
  /** The app's state as the last event left it. */
  appState: AppStateStatus;
  /** The automatic prompt of this lock already ran (once per return to the foreground). */
  autoPrompted: boolean;
  /** Why the last prompt did not unlock; a cancel is not a failure. */
  failure: "failed" | "unavailable" | null;
}

export function initialLock(appState: AppStateStatus): LockState {
  return {
    enabled: false,
    locked: false,
    backgroundedAt: null,
    prompting: false,
    appState,
    autoPrompted: false,
    failure: null,
  };
}

export function reduceLock(state: LockState, event: LockEvent): LockState {
  switch (event.kind) {
    case "boot":
      return {
        ...state,
        enabled: event.enabled,
        locked: event.enabled,
        backgroundedAt: null,
        prompting: false,
        autoPrompted: false,
        failure: null,
      };
    case "appState": {
      const next = { ...state, appState: event.to };
      // iOS goes active -> inactive -> background: the first arrival in the background counts.
      if (event.to === "background")
        return { ...next, backgroundedAt: state.backgroundedAt ?? event.at };
      if (event.to !== "active") return next;
      // inactive -> active without a background spell never locks.
      if (state.backgroundedAt === null) return next;
      const expired = state.enabled && event.at - state.backgroundedAt >= LOCK_AFTER_MS;
      const locked = state.locked || expired;
      return locked
        ? { ...next, backgroundedAt: null, locked, autoPrompted: false, failure: null }
        : { ...next, backgroundedAt: null };
    }
    case "unlocked":
      return { ...state, locked: false, prompting: false, failure: null };
    case "setting":
      return event.enabled
        ? { ...state, enabled: true }
        : { ...state, enabled: false, locked: false, failure: null };
    case "prompt":
      return { ...state, prompting: true, autoPrompted: true, failure: null };
    case "promptEnded":
      return {
        ...state,
        prompting: false,
        failure: event.result === "cancelled" ? null : event.result,
      };
  }
}

/** Locked in the foreground with no prompt open and none run yet: the gate prompts on its own. */
export function dueForPrompt(state: LockState): boolean {
  return state.locked && state.appState === "active" && !state.prompting && !state.autoPrompted;
}
