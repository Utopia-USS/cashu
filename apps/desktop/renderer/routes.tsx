import { investmentEntityIdSchema } from "@cashu/store/investments/screen-sources";
import { overviewQueries, profileIdentity } from "@cashu/store/overview";
import { useProfile, useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  useLocation,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  createContext,
  type ReactNode,
  startTransition,
  use,
  useEffect,
  useRef,
  useState,
} from "react";
import { z } from "zod";
import { S } from "./Desktop.strings.js";
import { AssetsStartScreen } from "./screens/assets/AssetsStartScreen.js";
import { BudgetView } from "./screens/budget/BudgetView.js";
import { type BudgetTab, useBudgetScreen } from "./screens/budget/useBudgetScreen.js";
import { PortfolioScreen } from "./screens/investments/PortfolioScreen.js";
import { LoansScreen } from "./screens/loans/LoansScreen.js";
import { OverviewView } from "./screens/overview/OverviewView.js";
import { useAssetDrawer } from "./screens/overview/useAssetDrawer.js";
import { useCashDrawer } from "./screens/overview/useCashDrawer.js";
import { useInvestmentPlan } from "./screens/overview/useInvestmentPlan.js";
import { useOverviewScreen } from "./screens/overview/useOverviewScreen.js";
import { ProposalDrawerScreen } from "./screens/proposals/ProposalDrawerScreen.js";
import { ResearchScreen } from "./screens/research/ResearchScreen.js";
import { SettingsView } from "./screens/settings/SettingsView.js";
import { UpdateNoticeView } from "./screens/settings/UpdateNoticeView.js";
import { useSettingsScreen } from "./screens/settings/useSettingsScreen.js";
import { useUpdateNotice } from "./screens/settings/useUpdateNotice.js";
import { SignalsPageScreen } from "./screens/signals/SignalsPageScreen.js";
import { StrategiesScreen } from "./screens/strategies/StrategiesScreen.js";
import { StrategySettingsView } from "./screens/strategies/StrategiesView.js";
import { useStrategiesScreen } from "./screens/strategies/useStrategiesScreen.js";
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
const LegacyNavigation = createContext<{
  allowed: boolean;
  open(tab: string): void;
  openModule(module: string): void;
}>({
  allowed: false,
  open: () => {},
  openModule: () => {},
});
const ProposalNavigation = createContext<{
  open(gid: string, onResumed?: () => void): boolean;
}>({ open: () => false });

/** TRANSITIONAL(S55z): unported SPA pages retain their own routes and deep-link search. */
function openLegacy(slug: string, tab: string) {
  const url = new URL("/", location.origin);
  url.searchParams.set("native", "1");
  url.hash = `/${encodeURIComponent(slug)}/${LEGACY_TABS[tab] ?? tab}`;
  location.assign(url.href);
}

/** Route-owned proposal selection resets when the vault or owner policy scope changes. */
function ProposalScope({
  vault,
  privacy,
  children,
}: {
  vault: string;
  privacy: boolean;
  children: ReactNode;
}) {
  const [proposal, setProposal] = useState<{ gid: string; onResumed?: () => void } | null>(null);
  const close = () => {
    proposal?.onResumed?.();
    setProposal(null);
  };
  return (
    <ProposalNavigation
      value={{
        open: (gid, onResumed) => {
          if (privacy) return false;
          setProposal({ gid, onResumed });
          return true;
        },
      }}
    >
      {children}
      {proposal && (
        <ProposalDrawerScreen
          key={`${vault}:${privacy}:${proposal.gid}`}
          gid={proposal.gid}
          onClose={close}
          onOutcome={(outcome) => {
            if (outcome.status === "approved" || outcome.status === "rejected") close();
          }}
        />
      )}
    </ProposalNavigation>
  );
}

function ShellRoute() {
  const updateNotice = useUpdateNotice();
  const state = useShellScreen({
    onProfileOpened: ({ slug, vault }) => {
      void router.navigate({ to: "/$slug/overview", params: { slug }, search: { vault } });
    },
  });
  const params = useParams({ strict: false });
  const pathname = useLocation({ select: (location) => location.pathname });
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
  const openModule = (module: string) => {
    if (state.profile === null) return;
    const slug = state.profile.slug;
    const vault = state.vault;
    if (module === "budget")
      void router.navigate({
        to: "/$slug/budget/$tab",
        params: { slug, tab: "expenses" },
        search: { vault, currency: budgetCurrencyByVault.get(vault) },
      });
    else if (module === "loans")
      void router.navigate({ to: "/$slug/loans.list", params: { slug }, search: { vault } });
    else if (module === "assets")
      void router.navigate({ to: "/$slug/setup/assets", params: { slug }, search: { vault } });
    else if (module === "investments")
      void router.navigate({
        to: "/$slug/investments.portfolio",
        params: { slug },
        search: { vault, period: "1y", view: "chart" },
      });
    else if (module === "settings")
      void router.navigate({ to: "/$slug/settings", params: { slug }, search: { vault } });
    else if (state.canOpenLegacy) openLegacy(slug, module);
    else state.onLegacyRefused();
  };
  const legacy = {
    openModule,
    allowed: state.canOpenLegacy,
    open: (tab: string) => {
      if (state.profile !== null && state.canOpenLegacy) openLegacy(state.profile.slug, tab);
      else state.onLegacyRefused();
    },
  };
  return (
    <ProposalScope
      key={`${state.vault}:${state.privacy}`}
      vault={state.vault}
      privacy={state.privacy}
    >
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
        activeModule={
          pathname.endsWith("/settings")
            ? "settings"
            : pathname.includes("/budget/")
              ? "budget"
              : pathname.endsWith("/loans.list") || pathname.endsWith("/setup/loans")
                ? "loans"
                : pathname.endsWith("/setup/assets")
                  ? "assets"
                  : pathname.includes("/investments.") || pathname.includes("/assets/")
                    ? "investments"
                    : "overview"
        }
        onLegacyOpened={openModule}
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
      <UpdateNoticeView state={updateNotice} />
    </ProposalScope>
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
      nativeModules={["budget", "loans", "assets", "investments"]}
      onModuleOpened={legacy.openModule}
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
  const enabled = useQuery(budgetModuleQuery).some(
    (module) => module.id === "budget" && module.enabled,
  );
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

const loansRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/loans.list",
  validateSearch: (raw) => search.parse(raw),
  component: LoansRoute,
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
});
const loansSetupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/setup/loans",
  validateSearch: (raw) => search.parse(raw),
  component: LoansSetupRoute,
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
});
const assetsStartRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/setup/assets",
  validateSearch: (raw) => search.parse(raw),
  component: AssetsStartRoute,
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
});
function LoansRoute() {
  const enabled = useQuery(budgetModuleQuery).some(
    (module) => module.id === "loans" && module.enabled,
  );
  return enabled ? <LoansScreen /> : <p className="p-6">{S.setup}</p>;
}
function LoansSetupRoute() {
  const enabled = useQuery(budgetModuleQuery).some(
    (module) => module.id === "loans" && module.enabled,
  );
  return enabled ? <LoansScreen setup /> : <p className="p-6">{S.setup}</p>;
}
function AssetsStartRoute() {
  const { slug } = assetsStartRoute.useParams();
  const vault = useProfile();
  const enabled = useQuery(budgetModuleQuery).some(
    (module) => module.id === "assets" && module.enabled,
  );
  return enabled ? (
    <AssetsStartScreen
      onSaved={() => {
        void router.navigate({ to: "/$slug/overview", params: { slug }, search: { vault } });
      }}
    />
  ) : (
    <p className="p-6">{S.setup}</p>
  );
}

const investmentSearch = z.object({
  vault: z
    .string()
    .regex(/^[0-9a-f]{32}$/)
    .optional(),
  account: investmentEntityIdSchema.optional(),
  period: z.enum(["1m", "3m", "ytd", "1y", "3y", "max"]).default("1y"),
  view: z.enum(["chart", "table"]).default("chart"),
  review: z.literal("1").optional(),
  signals: z.literal("1").optional(),
  note: investmentEntityIdSchema.optional(),
});
const investmentPageSearch = z.object({
  vault: search.shape.vault,
  instrument: investmentEntityIdSchema.optional(),
  alert: investmentEntityIdSchema.optional(),
});
const researchSearch = z.object({
  vault: search.shape.vault,
  tab: z.enum(["topics", "mine", "notes", "calendar", "candidates", "runs"]).optional(),
  topic: z.string().max(120).optional(),
  note: investmentEntityIdSchema.optional(),
});
const portfolioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/investments.portfolio",
  validateSearch: (raw) => investmentSearch.parse(raw),
  component: PortfolioRoute,
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
});
const investmentAssetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/assets/$instrument",
  validateSearch: (raw) => investmentSearch.parse(raw),
  component: PortfolioRoute,
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
});
const strategiesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/investments.strategies",
  validateSearch: (raw) => search.pick({ vault: true }).parse(raw),
  component: StrategiesRoute,
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
});
const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/settings",
  validateSearch: (raw) =>
    search
      .pick({ vault: true })
      .extend({
        section: z
          .enum(["profile", "modules", "agent", "connectors", "data", "worker", "secrets", "app"])
          .optional(),
      })
      .parse(raw),
  component: SettingsRoute,
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
});
function SettingsRoute() {
  const { slug } = settingsRoute.useParams();
  const { section } = settingsRoute.useSearch();
  const vault = useProfile();
  const { privacy } = useUiEnv();
  const proposals = use(ProposalNavigation);
  return (
    <SettingsBound
      key={`${vault}:${privacy}`}
      section={section}
      onProposalOpened={(gid) => {
        proposals.open(gid);
      }}
      onModuleConfigured={(id) => {
        if (id === "loans")
          void router.navigate({ to: "/$slug/setup/loans", params: { slug }, search: { vault } });
        else if (id === "assets")
          void router.navigate({ to: "/$slug/setup/assets", params: { slug }, search: { vault } });
        else if (id === "investments")
          void router.navigate({
            to: "/$slug/investments.strategies",
            params: { slug },
            search: { vault },
          });
        else
          void router.navigate({
            to: "/$slug/budget/$tab",
            params: { slug, tab: "expenses" },
            search: { vault },
          });
      }}
    />
  );
}
function SettingsBound({
  section,
  onProposalOpened,
  onModuleConfigured,
}: {
  section?: string;
  onProposalOpened(gid: string): void;
  onModuleConfigured(id: string): void;
}) {
  const state = useSettingsScreen(onProposalOpened, onModuleConfigured);
  const strategies = useStrategiesScreen(onProposalOpened);
  return (
    <SettingsView
      state={state}
      section={section}
      strategyPanel={
        state.modules.some((module) => module.id === "investments" && module.enabled) ? (
          <StrategySettingsView state={strategies} />
        ) : null
      }
    />
  );
}
const alertsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/investments.alerts",
  validateSearch: (raw) => investmentPageSearch.parse(raw),
  component: InvestmentPageRoute,
  errorComponent: RouteFailure,
});
const watchlistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/investments.watchlist",
  validateSearch: (raw) => investmentPageSearch.parse(raw),
  component: InvestmentPageRoute,
  errorComponent: RouteFailure,
});
const journalRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/investments.journal",
  validateSearch: (raw) => investmentPageSearch.parse(raw),
  component: InvestmentPageRoute,
  errorComponent: RouteFailure,
});
const researchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/investments.research",
  validateSearch: (raw) => researchSearch.parse(raw),
  component: ResearchRoute,
  errorComponent: RouteFailure,
});
function useInvestmentEnabled() {
  return useQuery(overviewQueries({ prices: null }).moduleStates).some(
    (module) => module.id === "investments" && module.enabled,
  );
}
function InvestmentPageRoute() {
  const { slug } = useParams({ strict: false });
  const pathname = useLocation({ select: (location) => location.pathname });
  const selected = useSearch({ strict: false }) as z.infer<typeof investmentPageSearch>;
  const vault = useProfile();
  const enabled = useInvestmentEnabled();
  if (!enabled) return <p className="p-6">{S.setup}</p>;
  const page = pathname.endsWith("investments.alerts")
    ? "alerts"
    : pathname.endsWith("investments.watchlist")
      ? "watchlist"
      : "journal";
  return (
    <SignalsPageScreen
      page={page}
      initialInstrument={selected.instrument}
      onClose={() =>
        void router.navigate({
          to: "/$slug/investments.portfolio",
          params: { slug: slug ?? "" },
          search: { vault, period: "1y", view: "chart" },
        })
      }
      onOpenAsset={(instrument) =>
        void router.navigate({
          to: "/$slug/assets/$instrument",
          params: { slug: slug ?? "", instrument },
          search: { vault, period: "1y", view: "chart" },
        })
      }
      onOpenReview={() =>
        void router.navigate({
          to: "/$slug/investments.portfolio",
          params: { slug: slug ?? "" },
          search: { vault, period: "1y", view: "chart", review: "1" },
        })
      }
      onOpenNote={(note) =>
        note &&
        void router.navigate({
          to: "/$slug/investments.research",
          params: { slug: slug ?? "" },
          search: { vault, note },
        })
      }
    />
  );
}
function ResearchRoute() {
  const { slug } = researchRoute.useParams();
  const selected = researchRoute.useSearch();
  const vault = useProfile();
  const enabled = useInvestmentEnabled();
  if (!enabled) return <p className="p-6">{S.setup}</p>;
  return (
    <ResearchScreen
      initialTab={selected.tab}
      initialTopic={selected.topic}
      initialNote={selected.note}
      onBack={() =>
        void router.navigate({
          to: "/$slug/investments.portfolio",
          params: { slug },
          search: { vault, period: "1y", view: "chart" },
        })
      }
      onOpenAsset={(instrument, note) =>
        void router.navigate({
          to: "/$slug/assets/$instrument",
          params: { slug, instrument },
          search: { vault, period: "1y", view: "chart", note },
        })
      }
      onSettings={() =>
        void router.navigate({
          to: "/$slug/investments.strategies",
          params: { slug },
          search: { vault },
        })
      }
    />
  );
}

function PortfolioRoute() {
  const { slug, instrument } = useParams({ strict: false });
  const selected = useSearch({ strict: false }) as z.infer<typeof investmentSearch>;
  const vault = useProfile();
  const modules = useQuery(overviewQueries({ prices: null }).moduleStates);
  const legacy = use(LegacyNavigation);
  const proposals = use(ProposalNavigation);
  if (!modules.some((module) => module.id === "investments" && module.enabled))
    return <p className="p-6">{S.setup}</p>;
  if (instrument !== undefined && !investmentEntityIdSchema.safeParse(instrument).success)
    return <p className="p-6">{S.setup}</p>;
  const navigate = (patch: Partial<z.infer<typeof investmentSearch>>) => {
    startTransition(() => {
      if (instrument === undefined)
        void router.navigate({
          to: "/$slug/investments.portfolio",
          params: { slug: slug ?? "" },
          search: { ...selected, ...patch, vault },
        });
      else
        void router.navigate({
          to: "/$slug/assets/$instrument",
          params: { slug: slug ?? "", instrument },
          search: { ...selected, ...patch, vault },
        });
    });
  };
  return (
    <PortfolioScreen
      {...(instrument === undefined ? {} : { instrument })}
      review={selected.review === "1"}
      signalsOpen={selected.signals === "1"}
      noteGid={selected.note}
      onReviewClosed={() => navigate({ review: undefined })}
      onReviewOpened={() => navigate({ review: "1" })}
      onProposalOpened={proposals.open}
      onSignalsClosed={() => navigate({ signals: undefined })}
      onSignalsPageOpened={(page) =>
        void router.navigate({
          to:
            page === "alerts"
              ? "/$slug/investments.alerts"
              : page === "watchlist"
                ? "/$slug/investments.watchlist"
                : "/$slug/investments.journal",
          params: { slug: slug ?? "" },
          search: { vault },
        })
      }
      onResearchOpened={(tab, topic, note) =>
        void router.navigate({
          to: "/$slug/investments.research",
          params: { slug: slug ?? "" },
          search: { vault, tab: tab as z.infer<typeof researchSearch>["tab"], topic, note },
        })
      }
      account={selected.account ?? null}
      range={selected.period}
      table={selected.view === "table"}
      onAccountPicked={(account) => navigate({ account: account ?? undefined })}
      onRangePicked={(period) => navigate({ period: investmentSearch.shape.period.parse(period) })}
      onTablePicked={(table) => navigate({ view: table ? "table" : "chart" })}
      openPage={(next) => {
        void router.navigate({
          to: "/$slug/assets/$instrument",
          params: { slug: slug ?? "", instrument: next },
          search: {
            vault,
            period: selected.period,
            view: selected.view,
            ...(selected.account === undefined ? {} : { account: selected.account }),
          },
        });
      }}
      openAdjacent={(tab) => {
        if (tab === "investments.strategies")
          void router.navigate({
            to: "/$slug/investments.strategies",
            params: { slug: slug ?? "" },
            search: { vault },
          });
        else if (tab === "investments.signals")
          void router.navigate({
            to: "/$slug/investments.portfolio",
            params: { slug: slug ?? "" },
            search: { vault, period: selected.period, view: selected.view, signals: "1" },
          });
        else if (tab === "investments.research")
          void router.navigate({
            to: "/$slug/investments.research",
            params: { slug: slug ?? "" },
            search: { vault },
          });
        else if (tab === "investments.review") navigate({ review: "1" });
        else legacy.open(tab);
      }}
    />
  );
}
function StrategiesRoute() {
  const modules = useQuery(overviewQueries({ prices: null }).moduleStates);
  const proposals = use(ProposalNavigation);
  return modules.some((module) => module.id === "investments" && module.enabled) ? (
    <StrategiesScreen
      onProposalOpened={(gid) => {
        proposals.open(gid);
      }}
    />
  ) : (
    <p className="p-6">{S.setup}</p>
  );
}

export const router = createRouter({
  routeTree: rootRoute.addChildren([
    startRoute,
    overviewRoute,
    budgetRoute,
    loansRoute,
    loansSetupRoute,
    assetsStartRoute,
    portfolioRoute,
    investmentAssetRoute,
    strategiesRoute,
    alertsRoute,
    watchlistRoute,
    journalRoute,
    researchRoute,
    settingsRoute,
  ]),
  history: createHashHistory(),
});
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
