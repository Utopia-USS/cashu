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
import { useOpenCreation } from "./creationContext.js";
import { S } from "./Desktop.strings.js";
import { NotificationSignalFocus } from "./notificationFocusContext.js";
import { AssetsStartScreen } from "./screens/assets/AssetsStartScreen.js";
import { BankingSettingsPanel } from "./screens/banking/BankingSettingsPanel.js";
import { BudgetView } from "./screens/budget/BudgetView.js";
import { type BudgetTab, useBudgetScreen } from "./screens/budget/useBudgetScreen.js";
import { ClassificationPanel } from "./screens/classification/ClassificationPanel.js";
import { DevicesScreen } from "./screens/devices/DevicesScreen.js";
import { PortfolioScreen } from "./screens/investments/PortfolioScreen.js";
import { LoansScreen } from "./screens/loans/LoansScreen.js";
import { MinimalOverviewView } from "./screens/overview/MinimalOverviewView.js";
import { investmentsOnlyOverview } from "./screens/overview/minimalOverview.js";
import { OverviewView } from "./screens/overview/OverviewView.js";
import { useAssetDrawer } from "./screens/overview/useAssetDrawer.js";
import { useCashDrawer } from "./screens/overview/useCashDrawer.js";
import { useInvestmentPlan } from "./screens/overview/useInvestmentPlan.js";
import { useMinimalOverview } from "./screens/overview/useMinimalOverview.js";
import { useOverviewScreen } from "./screens/overview/useOverviewScreen.js";
import { ProposalDrawerScreen } from "./screens/proposals/ProposalDrawerScreen.js";
import { SettingsView } from "./screens/settings/SettingsView.js";
import { UpdateNoticeView } from "./screens/settings/UpdateNoticeView.js";
import { useSettingsScreen } from "./screens/settings/useSettingsScreen.js";
import { useUpdateNotice } from "./screens/settings/useUpdateNotice.js";
import type { SetupNavigation } from "./screens/setup/actionIntent.js";
import { SetupScreen } from "./screens/setup/SetupScreen.js";
import { SignalsPageScreen } from "./screens/signals/SignalsPageScreen.js";
import { StrategiesScreen } from "./screens/strategies/StrategiesScreen.js";
import { StrategySettings } from "./screens/strategies/StrategySettings.js";
import { resolveProfileRoute } from "./shell/profileRoute.js";
import { ProfileRouteSync } from "./shell/profileRouteSync.js";
import { ShellView } from "./shell/ShellView.js";
import { useCalendarDay } from "./shell/useCalendarDay.js";
import { useShellScreen } from "./shell/useShellScreen.js";

const budgetCurrencyByVault = new Map<string, string>();

const ProposalNavigation = createContext<{
  open(gid: string, onResumed?: () => void): boolean;
}>({ open: () => false });

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
  const openCreation = useOpenCreation();
  const updateNotice = useUpdateNotice();
  const state = useShellScreen({
    onProfileOpened: ({ slug, vault }) => {
      void router.navigate({ to: "/$slug/overview", params: { slug }, search: { vault } });
    },
  });
  const params = useParams({ strict: false });
  const pathname = useLocation({ select: (location) => location.pathname });
  // Old v2/Home.tsx setNarrow(assetPage): the asset page (`assets/{gid}?page=1`) keeps the 1120px frame.
  const assetPage = useLocation({
    select: (location) =>
      location.pathname.includes("/assets/") &&
      String((location.search as { page?: unknown }).page ?? "") === "1",
  });
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
    else if (module === "investments.strategies")
      void router.navigate({
        to: "/$slug/investments.strategies",
        params: { slug },
        search: { vault },
      });
    else if (module === "settings")
      void router.navigate({ to: "/$slug/settings", params: { slug }, search: { vault } });
    else void router.navigate({ to: "/$slug/overview", params: { slug }, search: { vault } });
  };
  return (
    <ProposalScope
      key={`${state.vault}:${state.privacy}`}
      vault={state.vault}
      privacy={state.privacy}
    >
      <ShellView
        state={state}
        onAddProfile={openCreation}
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
                  : pathname.endsWith("/investments.strategies")
                    ? "investments.strategies"
                    : pathname.includes("/investments.") || pathname.includes("/assets/")
                      ? "investments"
                      : "overview"
        }
        narrow={assetPage}
        onModuleOpened={openModule}
      >
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
  return <RouteFailure />;
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

const overviewModuleQuery = overviewQueries({ prices: null }).moduleStates;

/** A profile with investments as its only module gets the minimal overview (Python `MinimalOverview`). */
function OverviewBound(props: { vault: string; slug: string; currency?: string }) {
  const modules = useQuery(overviewModuleQuery).filter((module) => module.enabled);
  return investmentsOnlyOverview(modules) ? (
    <MinimalOverviewBound vault={props.vault} slug={props.slug} />
  ) : (
    <FullOverviewBound {...props} />
  );
}

function MinimalOverviewBound({ vault, slug }: { vault: string; slug: string }) {
  const state = useMinimalOverview({
    today: useCalendarDay(),
    openNewAlert: () =>
      void router.navigate({
        to: "/$slug/investments.alerts",
        params: { slug },
        search: { vault, newAlert: "1" },
      }),
    openWatchlist: () =>
      void router.navigate({
        to: "/$slug/investments.watchlist",
        params: { slug },
        search: { vault },
      }),
  });
  return <MinimalOverviewView state={state} />;
}

/** A profile switch discards drawer drafts before commands can bind to the newly selected vault. */
function FullOverviewBound({
  vault,
  slug,
  currency,
}: {
  vault: string;
  slug: string;
  currency?: string;
}) {
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
      onCurrencyPicked={(next) =>
        startTransition(() => {
          void router.navigate({
            to: "/$slug/overview",
            params: { slug },
            search: { currency: next, vault },
          });
        })
      }
      onModuleOpened={(module) => {
        if (module === "assets")
          void router.navigate({ to: "/$slug/setup/assets", params: { slug }, search: { vault } });
        else if (module === "loans")
          void router.navigate({ to: "/$slug/loans.list", params: { slug }, search: { vault } });
        else if (module === "budget")
          void router.navigate({
            to: "/$slug/budget/$tab",
            params: { slug, tab: "expenses" },
            search: { vault },
          });
        else if (module === "investments")
          void router.navigate({
            to: "/$slug/investments.portfolio",
            params: { slug },
            search: { vault, period: "1y", view: "chart" },
          });
      }}
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
const setupGuideRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/setup/$module/cli",
  validateSearch: (raw) => search.pick({ vault: true }).parse(raw),
  component: SetupGuideRoute,
  errorComponent: RouteFailure,
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/setup/$module",
  validateSearch: (raw) => search.pick({ vault: true }).parse(raw),
  component: SetupGuideRoute,
  errorComponent: RouteFailure,
});
function SetupGuideRoute() {
  const { slug, module } = useParams({ strict: false });
  const vault = useProfile();
  const onNavigate = (target: SetupNavigation) => {
    if (target.kind === "settings") {
      const section = z
        .enum(["profile", "modules", "agent", "connectors", "data", "worker", "secrets", "app"])
        .safeParse(target.section);
      if (!section.success) return;
      void router.navigate({
        to: "/$slug/settings",
        params: { slug: slug ?? "" },
        search: { vault, section: section.data },
      });
    } else if (target.kind === "overview")
      void router.navigate({
        to: "/$slug/overview",
        params: { slug: slug ?? "" },
        search: { vault },
      });
    else if (target.module === "budget")
      void router.navigate({
        to: "/$slug/budget/$tab",
        params: { slug: slug ?? "", tab: target.tab },
        search: { vault },
      });
    else if (target.module === "loans")
      void router.navigate({
        to: "/$slug/loans.list",
        params: { slug: slug ?? "" },
        search: { vault },
      });
    else if (target.module === "investments") {
      if (target.tab === "strategies")
        void router.navigate({
          to: "/$slug/investments.strategies",
          params: { slug: slug ?? "" },
          search: { vault },
        });
      else if (["alerts", "watchlist", "journal"].includes(target.tab))
        void router.navigate({
          to:
            target.tab === "alerts"
              ? "/$slug/investments.alerts"
              : target.tab === "watchlist"
                ? "/$slug/investments.watchlist"
                : "/$slug/investments.journal",
          params: { slug: slug ?? "" },
          search: { vault },
        });
      else if (target.tab === "research")
        void router.navigate({
          to: "/$slug/investments.research",
          params: { slug: slug ?? "" },
          search: { vault, period: "1y", view: "chart" },
        });
      else if (["portfolio", "review"].includes(target.tab))
        void router.navigate({
          to: "/$slug/investments.portfolio",
          params: { slug: slug ?? "" },
          search: {
            vault,
            period: "1y",
            view: "chart",
            ...(target.tab === "review" ? { review: "1" as const } : {}),
          },
        });
    }
  };
  return (
    <SetupScreen
      moduleId={module ?? ""}
      agent={{ kind: "unavailable", reason: "source_unbound" }}
      onNavigate={onNavigate}
      onCopy={async (value) => navigator.clipboard.writeText(value)}
    />
  );
}
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
  /** `assets/{gid}?page=1`: the asset page in place of the Home grid (else the asset drawer over it). */
  page: z.literal("1").optional(),
  /** The research page's tab (`investments.research?tab=`). */
  tab: z.enum(["topics", "mine", "notes", "calendar", "candidates", "runs"]).optional(),
  /** The topic drawer over the Home (old `topics/<key>`): a segment key or a macro regime's `macro_<key>`. */
  topic: z
    .string()
    .regex(/^[a-z0-9_]{1,120}$/)
    .optional(),
});
const investmentPageSearch = z.object({
  vault: search.shape.vault,
  instrument: investmentEntityIdSchema.optional(),
  alert: investmentEntityIdSchema.optional(),
  newAlert: z.literal("1").optional(),
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
  return (
    <SettingsView
      devicesPanel={<DevicesScreen />}
      bankingPanel={
        state.modules.some((module) => module.id === "budget" && module.enabled) ? (
          <BankingSettingsPanel />
        ) : null
      }
      classificationPanel={
        state.modules.some((module) => module.id === "budget" && module.enabled) ? (
          <ClassificationPanel />
        ) : null
      }
      state={state}
      section={section}
      strategyPanel={
        state.modules.some((module) => module.id === "investments" && module.enabled) ? (
          <StrategySettings onProposalOpened={onProposalOpened} />
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
  validateSearch: (raw) => investmentSearch.parse(raw),
  component: PortfolioRoute,
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
      initialNewAlert={page === "alerts" && selected.newAlert === "1"}
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
          search: { vault, period: "1y", view: "chart", note },
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
  const proposals = use(ProposalNavigation);
  const notificationSignal = use(NotificationSignalFocus);
  // `investments.research`: the research page in place of the Home grid (old sub-route `research`).
  const research = useLocation({ select: (l) => l.pathname.endsWith("/investments.research") });
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
      page={selected.page === "1"}
      slug={slug ?? ""}
      onSetupOpened={() =>
        void router.navigate({
          to: "/$slug/setup/$module",
          params: { slug: slug ?? "", module: "investments" },
          search: { vault },
        })
      }
      onSettingsOpened={() =>
        void router.navigate({
          to: "/$slug/settings",
          params: { slug: slug ?? "" },
          search: { vault, section: "agent" },
        })
      }
      review={selected.review === "1"}
      signalsOpen={selected.signals === "1"}
      signalFocusId={
        selected.signals === "1" && notificationSignal?.vault === vault
          ? notificationSignal.signalId
          : undefined
      }
      noteGid={selected.note}
      onReviewClosed={() => navigate({ review: undefined })}
      onReviewOpened={() => navigate({ review: "1" })}
      onProposalOpened={proposals.open}
      onSignalsClosed={() => navigate({ signals: undefined })}
      onSignalsPageOpened={(page, newAlert) =>
        void router.navigate({
          to:
            page === "alerts"
              ? "/$slug/investments.alerts"
              : page === "watchlist"
                ? "/$slug/investments.watchlist"
                : "/$slug/investments.journal",
          params: { slug: slug ?? "" },
          search: { vault, ...(newAlert ? { newAlert: "1" as const } : {}) },
        })
      }
      research={research ? { tab: selected.tab, note: selected.note ?? null } : null}
      onResearchOpened={(tab, note) =>
        void router.navigate({
          to: "/$slug/investments.research",
          params: { slug: slug ?? "" },
          search: {
            vault,
            period: selected.period,
            view: selected.view,
            tab: investmentSearch.shape.tab.catch(undefined).parse(tab),
            note,
          },
        })
      }
      topic={selected.topic ?? null}
      onTopicOpened={(key) =>
        void router.navigate({
          to: "/$slug/investments.portfolio",
          params: { slug: slug ?? "" },
          search: {
            vault,
            period: selected.period,
            view: selected.view,
            ...(selected.account === undefined ? {} : { account: selected.account }),
            topic: key,
          },
        })
      }
      onTopicClosed={() =>
        startTransition(() => {
          void router.navigate({
            to: "/$slug/investments.portfolio",
            params: { slug: slug ?? "" },
            search: { ...selected, topic: undefined, vault },
          });
        })
      }
      account={selected.account ?? null}
      range={selected.period}
      onAccountPicked={(account) => navigate({ account: account ?? undefined })}
      onRangePicked={(period) => navigate({ period: investmentSearch.shape.period.parse(period) })}
      onAssetClosed={() =>
        startTransition(() => {
          void router.navigate({
            to: "/$slug/investments.portfolio",
            params: { slug: slug ?? "" },
            search: { ...selected, page: undefined, note: undefined, tab: undefined, vault },
          });
        })
      }
      onAssetPageOpened={(next) =>
        void router.navigate({
          to: "/$slug/assets/$instrument",
          params: { slug: slug ?? "", instrument: next },
          search: { ...selected, note: undefined, page: "1", vault },
        })
      }
      onAlertsOpened={(next, newAlert) =>
        void router.navigate({
          to: "/$slug/investments.alerts",
          params: { slug: slug ?? "" },
          search: { vault, instrument: next, ...(newAlert ? { newAlert: "1" as const } : {}) },
        })
      }
      onJournalOpened={(next) =>
        void router.navigate({
          to: "/$slug/investments.journal",
          params: { slug: slug ?? "" },
          search: { vault, instrument: next },
        })
      }
      openPage={(next, note) => {
        void router.navigate({
          to: "/$slug/assets/$instrument",
          params: { slug: slug ?? "", instrument: next },
          search: {
            vault,
            period: selected.period,
            view: selected.view,
            ...(selected.account === undefined ? {} : { account: selected.account }),
            ...(note === undefined ? {} : { note }),
          },
        });
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
    setupGuideRoute,
    setupRoute,
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
