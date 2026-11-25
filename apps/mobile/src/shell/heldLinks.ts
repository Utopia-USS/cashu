// Deep links while navigation is held (pure, tested in Node). `app/+native-intent.ts` passes every
// system URL through `redirectSystemLink`: a link that arrives while navigation is held (the app lock)
// is kept here and does not navigate; the lock gate replays it once navigation is free
// (`useHeldLinkReplay`). A cold start's link is always kept and replayed after the first mount, because
// the lock decides whether it is locked only once the app has mounted.

import { isNavigationHeld } from "./navigationHold";

let pending: string | null = null;
const listeners = new Set<() => void>();

function setPending(next: string | null): void {
  if (next === pending) return;
  pending = next;
  for (const listener of [...listeners]) listener();
}

/** The in-app path of a system URL: `cashu:///sheet/profile` and `cashu://sheet/profile` -> `/sheet/profile`. */
export function linkPath(url: string): string {
  const rest = /^[a-z][a-z0-9+.-]*:\/\/(.*)$/is.exec(url)?.[1] ?? url;
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** The app's start (no route asked for), Expo Go's root included. */
const isRoot = (path: string) => /^\/(--\/?)?$/.test(path.replace(/[?#].*$/s, ""));

/** The development client's own launch URL: not a route of the app. */
const isDevClientLaunch = (path: string) => path.startsWith("/expo-development-client");

/**
 * expo-router's `redirectSystemPath`: the path to open now, or null to open nothing. A cold start's
 * link opens the app's start ("/", which goes to Today) and is replayed after the mount; a link while
 * navigation is held opens nothing and is replayed once it is free; any other link opens as it is.
 * Only the latest kept link is replayed.
 */
export function redirectSystemLink(event: { path: string; initial: boolean }): string | null {
  const target = linkPath(event.path);
  if (isRoot(target) || isDevClientLaunch(target)) return event.path;
  if (event.initial) {
    setPending(target);
    return "/";
  }
  if (isNavigationHeld()) {
    setPending(target);
    return null;
  }
  return event.path;
}

/** The kept link's path (null when none). */
export function pendingLink(): string | null {
  return pending;
}

/** `useSyncExternalStore` source of the kept link. */
export function subscribePendingLink(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Take the kept link (it is replayed once); null when none. */
export function takePendingLink(): string | null {
  const path = pending;
  setPending(null);
  return path;
}
