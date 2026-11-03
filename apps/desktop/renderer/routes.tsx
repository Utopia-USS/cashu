import { overviewQueries, profileIdentity } from "@cashu/store/overview";
import { useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
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
import { BudgetView } from "./screens/budget/BudgetView.js";
import { type BudgetTab, useBudgetScreen } from "./screens/budget/useBudgetScreen.js";
import { OverviewView } from "./screens/overview/OverviewView.js";
import { useAssetDrawer } from "./screens/overview/useAssetDrawer.js";
import { useCashDrawer } from "./screens/overview/useCashDrawer.js";
import { useInvestmentPlan } from "./screens/overview/useInvestmentPlan.js";
import { useOverviewScreen } from "./screens/overview/useOverviewScreen.js";
import { resolveProfileRoute } from "./shell/profileRoute.js";
import { ProfileRouteSync } from "./shell/profileRouteSync.js";
import { ShellView } from "./shell/ShellView.js";
import { useCalendarDay } from "./shell/useCalendarDay.js";
import { useShellScreen } from "./shell/useShellScreen.js";

const budgetCurrencyByVault = new Map<string, string>();

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
function openLegacy(slug: string, tab: string) {
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
      activeModule={params.tab !== undefined ? "budget" : "overview"}
      onLegacyOpened={(module) => {
        if (module === "budget" && state.profile !== null)
          void router.navigate({
            to: "/$slug/budget/$tab",
            params: { slug: state.profile.slug, tab: "expenses" },
            search: { vault: state.vault, currency: budgetCurrencyByVault.get(state.vault) },
          });
        else legacy.open(module);
      }}
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
  mode: z.enum(["month", "quarter", "year", "all"]).optional(),
  anchor: z.number().int().min(0).max(120000).optional(),
  gran: z.enum(["monthly", "quarterly", "yearly"]).optional(),
  range: z.number().int().min(0).max(240).optional(),
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  drill: z.string().max(100).optional(),
  sort: z.enum(["date", "amount"]).optional(),
  order: z.enum(["asc", "desc"]).optional(),
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/)
    .optional(),
});
const overviewRoute = createRoute({
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
  return <OverviewBound key={vault} vault={vault} slug={slug} currency={currency} />;
}

/** A profile switch discards drawer drafts before commands can bind to the newly selected vault. */
function OverviewBound({
  vault,
  slug,
  currency,
}: {
  vault: string;
  slug: string;
  currency?: string;
}) {
  const legacy = use(LegacyNavigation);
  const today = useCalendarDay();
  const state = useOverviewScreen({
    today,
    vault,
    ...(currency === undefined ? {} : { currency }),
  });
  const cash = useCashDrawer();
  const assets = useAssetDrawer(today, state.net?.currency ?? state.currency);
  const investmentPlan = useInvestmentPlan(state.investment, today);
  return (
    <OverviewView
      state={state}
      cash={cash}
      assets={assets}
      investmentPlan={investmentPlan}
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

const budgetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/budget/$tab",
  validateSearch: (raw) => search.parse(raw),
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
  component: BudgetRoute,
});
const budgetModuleQuery = overviewQueries({ prices: null }).moduleStates;

function BudgetRoute() {
  const { privacy } = useUiEnv();
  const enabled = useQuery(budgetModuleQuery).some((module) => module.id === "budget");
  const { slug, tab } = budgetRoute.useParams();
  const filters = budgetRoute.useSearch();
  const vault = useProfile();
  if (!enabled) return <p className="p-6">{S.setup}</p>;
  if (!["expenses", "flows", "subs"].includes(tab)) return <RouteFailure />;
  return (
    <BudgetBound
      key={`${vault}:${privacy}`}
      slug={slug}
      tab={tab as BudgetTab}
      vault={vault}
      filters={filters}
    />
  );
}
function BudgetBound({
  slug,
  tab,
  vault,
  filters,
}: {
  slug: string;
  tab: BudgetTab;
  vault: string;
  filters: ReturnType<typeof budgetRoute.useSearch>;
}) {
  const legacy = use(LegacyNavigation);
  const today = useCalendarDay();
  const modules = useQuery(profileIdentity);
  const state = useBudgetScreen({
    today,
    tab,
    filters,
    change: (next) =>
      startTransition(() => {
        if (next.currency) budgetCurrencyByVault.set(vault, next.currency);
        void router.navigate({
          to: "/$slug/budget/$tab",
          params: { slug, tab },
          search: { ...next, vault },
        });
      }),
  });
  if (modules === null) return <p>{S.noProfile}</p>;
  return (
    <BudgetView
      state={state}
      canOpenLegacy={legacy.allowed}
      onLegacyOpened={() => legacy.open("budget")}
      onTabPicked={(next) => {
        void router.navigate({
          to: "/$slug/budget/$tab",
          params: { slug, tab: next },
          search: { ...filters, vault },
        });
      }}
    />
  );
}

export const router = createRouter({
  routeTree: rootRoute.addChildren([startRoute, overviewRoute, budgetRoute]),
  history: createHashHistory(),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
