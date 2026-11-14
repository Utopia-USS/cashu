// The one way the phone switches profile, whatever asked for it (the profile sheet, a notification tap,
// any later source): every sheet and modal above the tabs is dismissed and each tab's stack goes back to
// its root FIRST, and only then the device command switches the current vault. No confirm: unsaved input
// of a sheet belongs to the other profile and is dropped. Data of one profile must never be written into
// another (rule 7), so a sheet or modal also pins the vault it was opened with (`usePinnedVault`): its
// commands write to that vault explicitly, and it renders nothing (and dismisses itself) once the current
// profile is another one.
import { setCurrentVault } from "@cashu/store/device";
import { type CommandOutcome, useCommand, useProfile } from "@cashu/store-react";
import { useNavigation, useNavigationContainerRef } from "expo-router";
import { useEffect, useState } from "react";

/** The part of a navigation state this module reads (react-navigation's full or partial state). */
export interface NavigationTree {
  readonly index?: number;
  readonly routes: readonly NavigationRoute[];
}
interface NavigationRoute {
  readonly key?: string;
  readonly name: string;
  readonly params?: object;
  readonly state?: NavigationTree;
}

const isTabsRoute = (name: string) => name === "(tabs)" || name.startsWith("(tabs)/");
const isKept = (name: string) => name === "index" || isTabsRoute(name);
/** A route of the app's root stack: the start, the tabs, a sheet or a modal. */
const isRootRoute = (name: string) =>
  isKept(name) || name.startsWith("sheet/") || name.startsWith("modal/");

/**
 * The navigation as a profile switch leaves it: in the app's root stack only the start route (`index`)
 * and the tabs stay (every sheet, modal and other route above them goes), and, with `tabs: "reset"`
 * (the default), each tab keeps its place in the bar but loses its nested stack (it opens on its root).
 * A stack left with neither (a sheet opened straight from a link) goes back to the start, which opens
 * Today. A navigator above the root stack is walked through; a tree without it is returned as it is.
 */
export function freshNavigationState<T extends NavigationTree>(
  state: T,
  tabs: "reset" | "keep" = "reset",
): T {
  if (!state.routes.some((route) => isRootRoute(route.name))) {
    return {
      ...state,
      routes: state.routes.map((route) =>
        route.state === undefined
          ? route
          : { ...route, state: freshNavigationState(route.state, tabs) },
      ),
    };
  }
  const kept = state.routes
    .filter((route) => isKept(route.name))
    .map((route) => {
      const nested = route.name === "(tabs)" && tabs === "reset" ? route.state : undefined;
      if (nested === undefined) return route;
      const fresh = nested.routes.map(({ key, name, params }) => ({ key, name, params }));
      return { ...route, state: { index: nested.index ?? 0, routes: fresh } };
    });
  if (kept.length === 0) return { ...state, index: 0, routes: [{ name: "index" }] };
  return { ...state, index: kept.length - 1, routes: kept };
}

type NavigationRef = ReturnType<typeof useNavigationContainerRef>;

/** The longest wait for the reset to land before the switch goes on anyway (it then still runs first). */
const SETTLE_MS = 250;

/**
 * Dismisses every sheet and modal and (with `tabs: "reset"`) resets the tab stacks; resolves once the
 * navigation took the reset. Nothing before the navigator is ready. The wait matters: the profile
 * change reaches React through the device store's external-store subscription, which renders before a
 * pending navigation update, so switching straight after the dispatch would render the open sheets
 * under the new profile first.
 */
function dismissForSwitch(
  navigation: NavigationRef,
  tabs: "reset" | "keep" = "reset",
): Promise<void> {
  if (!navigation.isReady()) return Promise.resolve();
  const root = navigation.getRootState();
  if (root === undefined) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = navigation.addListener("state", settle);
    const timer = setTimeout(settle, SETTLE_MS);
    // Aimed at the root navigator: an action without a target goes to the focused (innermost) one.
    navigation.dispatch({
      type: "RESET",
      payload: freshNavigationState(root, tabs),
      target: root.key,
    });
  });
}

export interface ProfileSwitch {
  /** Dismisses every sheet and modal, resets the tab stacks, then switches the current profile. */
  run(vault: string): Promise<CommandOutcome<unknown>>;
  readonly isPending: boolean;
}

/**
 * The vault the one switch already reset the navigation for. The tabs layout's own reset (for a switch
 * from elsewhere) skips once for it: run after the switch, it would drop the page a notification tap
 * opened for the new profile.
 */
let preparedFor: string | null = null;

/** True once after `useSwitchProfile` switched to `vault` (it already reset the navigation). */
export function takePreparedSwitch(vault: string): boolean {
  const prepared = preparedFor === vault;
  preparedFor = null;
  return prepared;
}

export function useSwitchProfile(): ProfileSwitch {
  const navigation = useNavigationContainerRef();
  const write = useCommand(setCurrentVault);
  return {
    run: async (vault) => {
      await dismissForSwitch(navigation);
      preparedFor = vault;
      const outcome = await write.run({ vault });
      if (outcome.kind !== "completed" && preparedFor === vault) preparedFor = null;
      return outcome;
    },
    isPending: write.isPending,
  };
}

/**
 * The vault a sheet or modal was opened with, for its commands (`useCommand(command, { vault })`), or
 * null once the current profile is another one: the route then renders nothing and every sheet and modal
 * is dismissed when the switch did not already do it. The tab stacks are left alone (the tabs layout
 * resets them for a switch from elsewhere).
 */
export function usePinnedVault(): string | null {
  const current = useProfile();
  const [pinned] = useState(current);
  const navigation = useNavigationContainerRef();
  const route = useNavigation();
  const moved = current !== pinned;
  useEffect(() => {
    // Only while this route is still the shown one: a route the switch already removed is just
    // closing, and a reset then (over tab navigators that are remounting) would lose the page a
    // notification tap opened for the new profile.
    if (moved && route.isFocused()) void dismissForSwitch(navigation, "keep");
  }, [moved, navigation, route]);
  return moved ? null : pinned;
}
