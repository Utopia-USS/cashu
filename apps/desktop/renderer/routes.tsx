import { profileIdentity } from "@cashu/store/overview";
import { useProfile, useQuery } from "@cashu/store-react";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { createContext, startTransition, use, useEffect, useRef } from "react";
import { z } from "zod";
import { S } from "./Desktop.strings.js";
import { OverviewView } from "./screens/overview/OverviewView.js";
import { useOverviewScreen } from "./screens/overview/useOverviewScreen.js";
import { resolveProfileRoute } from "./shell/profileRoute.js";
import { ProfileRouteSync } from "./shell/profileRouteSync.js";
import { ShellView } from "./shell/ShellView.js";
import { useCalendarDay } from "./shell/useCalendarDay.js";
import { useShellScreen } from "./shell/useShellScreen.js";

const LEGACY_TABS: Record<string, string> = {
  overview: "overview",
  budget: "budget.expenses",
  investments: "investments.portfolio",
  assets: "overview/assets",
  loans: "loans.list",
  settings: "settings",
};
const LegacyNavigation = createContext<{ allowed: boolean; open(tab: string): void }>({
  allowed: false,
  open: () => {},
});

/** TRANSITIONAL(S55z): unported SPA pages retain their own routes and deep-link search. */
export function openLegacy(slug: string, tab: string) {
  const url = new URL("/", location.origin);
  url.searchParams.set("native", "1");
  url.hash = `/${encodeURIComponent(slug)}/${LEGACY_TABS[tab] ?? tab}`;
  location.assign(url.href);
}

function ShellRoute() {
  const state = useShellScreen({
    onProfileOpened: ({ slug, vault }) => {
      void router.navigate({ to: "/$slug/overview", params: { slug }, search: { vault } });
    },
  });
  const params = useParams({ strict: false });
  const requested = useSearch({ strict: false });
  const selection =
    params.slug === undefined
      ? null
      : resolveProfileRoute(state.profiles, params.slug, requested.vault);
  const routeSync = useRef<ProfileRouteSync | null>(null);
  if (routeSync.current === null) routeSync.current = new ProfileRouteSync();
  useEffect(() => {
    routeSync.current?.update(
      selection?.kind === "ready" ? selection.profile.vault : null,
      state.vault,
      state.onRouteVaultPicked,
    );
  }, [selection, state.vault, state.onRouteVaultPicked]);
  const legacy = {
    allowed: state.canOpenLegacy,
    open: (tab: string) => {
      if (state.profile !== null && state.canOpenLegacy) openLegacy(state.profile.slug, tab);
      else state.onLegacyRefused();
    },
  };
  return (
    <ShellView
      state={state}
      onOverviewOpened={() => {
        if (state.profile !== null)
          void router.navigate({
            to: "/$slug/overview",
            params: { slug: state.profile.slug },
            search: { vault: state.vault },
          });
      }}
      onLegacyOpened={legacy.open}
    >
      <LegacyNavigation value={legacy}>
        {selection !== null &&
        (selection.kind !== "ready" || selection.profile.vault !== state.vault) ? (
          <p role="status" className="p-6">
            {selection.kind === "ambiguous"
              ? S.ambiguousProfile
              : selection.kind === "unavailable"
                ? S.noProfile
                : S.waiting}
          </p>
        ) : (
          <Outlet />
        )}
      </LegacyNavigation>
    </ShellView>
  );
}

export function RouteFailure() {
  return (
    <main className="p-6">
      <p role="alert">{S.failed}</p>
      <button type="button" onClick={() => location.reload()}>
        {S.retry}
      </button>
    </main>
  );
}

function StartRoute() {
  const profile = useQuery(profileIdentity);
  const vault = useProfile();
  useEffect(() => {
    if (profile !== null)
      void router.navigate({
        to: "/$slug/overview",
        params: { slug: profile.slug },
        search: { vault },
        replace: true,
      });
  }, [profile, vault]);
  return (
    <p role="status" className="p-6">
      {profile === null ? S.noProfile : S.waiting}
    </p>
  );
}

function LegacyRoute() {
  useEffect(() => {
    const url = new URL("/?native=1", location.origin);
    url.hash = location.hash;
    location.replace(url.href);
  }, []);
  return (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  );
}

const rootRoute = createRootRoute({
  component: ShellRoute,
  errorComponent: RouteFailure,
  notFoundComponent: LegacyRoute,
});
const startRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: StartRoute,
});
const search = z.object({
  vault: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
export const overviewRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/overview",
  validateSearch: (raw) => search.parse(raw),
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
  component: OverviewRoute,
});

function OverviewRoute() {
  const { currency } = overviewRoute.useSearch();
  const { slug } = overviewRoute.useParams();
  const vault = useProfile();
  const legacy = use(LegacyNavigation);
  const today = useCalendarDay();
  const state = useOverviewScreen({ today, ...(currency === undefined ? {} : { currency }) });
  return (
    <OverviewView
      state={state}
      canOpenLegacy={legacy.allowed}
      onCurrencyPicked={(next) =>
        startTransition(() => {
          void router.navigate({
            to: "/$slug/overview",
            params: { slug },
            search: { currency: next, vault },
          });
        })
      }
      onModuleOpened={legacy.open}
    />
  );
}

export const router = createRouter({
  routeTree: rootRoute.addChildren([startRoute, overviewRoute]),
  history: createHashHistory(),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
