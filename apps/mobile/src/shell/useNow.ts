// The app's one "today": the device-local calendar day and the moment it was read. Tab roots stay
// mounted for the life of the process, so the day must move on by itself: it is read again when the app
// returns from the background and at local midnight (one timer for the whole app, armed while anything
// listens). Every route that needs the day or the moment takes it from here and passes it down.
import type { IsoDate } from "@cashu/domain";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { localToday } from "../screens/screenContext";
import { emitNowTick } from "../services/nowTicks";

export interface Now {
  /** The device-local calendar day. */
  readonly today: IsoDate;
  /** The moment the day was read (ISO instant). */
  readonly now: string;
}

/** Past midnight by this much, so the timer never lands on the last millisecond of the old day. */
const MIDNIGHT_MARGIN_MS = 50;

function read(at = new Date()): Now {
  return { today: localToday(at), now: at.toISOString() };
}

/** Milliseconds from `at` to the next local midnight. */
export function msToMidnight(at: Date): number {
  const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
  return next.getTime() - at.getTime();
}

let current: Now = read();
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

function tick(): void {
  current = read();
  for (const listener of listeners) listener();
  emitNowTick();
}

function start(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      tick();
      arm();
    }, msToMidnight(new Date()) + MIDNIGHT_MARGIN_MS);
  };
  let previous: string | null | undefined = AppState.currentState;
  const subscription = AppState.addEventListener("change", (state) => {
    // A suspended process misses its timer: read the day again and re-arm on the way back.
    if (previous === "background" && state === "active") {
      tick();
      arm();
    }
    previous = state;
  });
  // The first listener may come long after this module loaded.
  current = read();
  arm();
  return () => {
    clearTimeout(timer);
    subscription.remove();
  };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  stop ??= start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stop?.();
      stop = null;
    }
  };
}

const snapshot = () => current;

/** Today and now, re-read on return from the background and at local midnight. */
export function useNow(): Now {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
