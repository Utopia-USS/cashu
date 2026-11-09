import { S as BI } from "@cashu/i18n/budget/index.strings";
import { investmentEntityIdSchema } from "@cashu/store/investments/screen-sources";
import { overviewQueries, profileIdentity } from "@cashu/store/overview";
import { useProfile, useQuery } from "@cashu/store-react";
import { Page, SkeletonTable, ToastProvider, useUiEnv } from "@cashu/ui";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
  useLocation,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  createContext,
  Fragment,
  type ReactNode,
  Suspense,
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
import { BudgetActions } from "./screens/budget/actions/BudgetActions.js";
import { ExpensesScreen } from "./screens/budget/expenses/ExpensesScreen.js";
import { FlowsScreen } from "./screens/budget/flows/FlowsScreen.js";
import { BudgetStartScreen } from "./screens/budget/start/BudgetStartScreen.js";
import { SubscriptionsScreen } from "./screens/budget/subs/SubscriptionsScreen.js";
import { ClassificationPanel } from "./screens/classification/ClassificationPanel.js";
import { DevicesScreen } from "./screens/devices/DevicesScreen.js";
import { InvestmentsHomeLoading } from "./screens/investments/home/InvestmentsHomeScreen.js";
import { PortfolioScreen } from "./screens/investments/PortfolioScreen.js";
import { LoansScreen } from "./screens/loans/LoansScreen.js";
import { MinimalOverviewScreen } from "./screens/overview/MinimalOverviewScreen.js";
import { investmentsOnlyOverview } from "./screens/overview/minimalOverview.js";
import { OverviewScreen } from "./screens/overview/OverviewScreen.js";
import { ProposalDrawerScreen } from "./screens/proposals/ProposalDrawerScreen.js";
import { SettingsView } from "./screens/settings/SettingsView.js";
import { UpdateNotice } from "./screens/settings/UpdateNotice.js";
import { useSettingsScreen } from "./screens/settings/useSettingsScreen.js";
import { SignalsPageScreen } from "./screens/signals/SignalsPageScreen.js";
import { StrategiesScreen } from "./screens/strategies/StrategiesScreen.js";
import { StrategySettings } from "./screens/strategies/StrategySettings.js";
import { InvestmentsHeaderTag } from "./shell/InvestmentsHeaderTag.js";
import { NarrowFrameContext } from "./shell/narrowFrame.js";
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
  // Old Shell `narrow`: a page asks for the 1120px frame (shell/narrowFrame.ts); the asset page asks through its route.
  const [pageNarrow, setPageNarrow] = useState(false);
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
    if (module === "budget" || module.startsWith("budget."))
      void router.navigate({
        to: "/$slug/budget/$tab",
        params: { slug, tab: module === "budget" ? "expenses" : module.slice("budget.".length) },
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
            : /\/setup\/budget(\/cli)?$/u.test(pathname)
              ? "budget.expenses"
              : pathname.includes("/budget/")
                ? `budget.${pathname.split("/budget/")[1]?.split("/")[0] ?? "expenses"}`
                : pathname.endsWith("/loans.list") || /\/setup\/loans(\/cli)?$/u.test(pathname)
                  ? "loans"
                  : /\/setup\/investments(\/cli)?$/u.test(pathname)
                    ? "investments"
                    : pathname.endsWith("/investments.strategies")
                      ? "investments.strategies"
                      : pathname.includes("/investments.") || pathname.includes("/assets/")
                        ? "investments"
                        : "overview"
        }
        narrow={assetPage || pageNarrow}
        onModuleOpened={openModule}
        headerTags={
          state.investmentsTag && state.profile !== null ? (
            <InvestmentsHeaderTag
              key={state.vault}
              onOpen={() => {
                const slug = state.profile?.slug ?? "";
                // Alokacja on its Rachunki view; `t` makes a repeated click a new request (old F8 FE-7).
                void router.navigate({
                  to: "/$slug/investments.portfolio",
                  params: { slug },
                  search: {
                    vault: state.vault,
                    period: "1y",
                    view: "chart",
                    alloc: "accounts",
                    t: Date.now(),
                  },
                });
                setTimeout(
                  () =>
                    (
                      document.getElementById("inv-alloc") ??
                      document.getElementById("inv-accounts")
                    )?.scrollIntoView({ behavior: "smooth", block: "start" }),
                  400,
                );
              }}
            />
          ) : undefined
        }
        tabActions={
          pathname.includes("/budget/") && state.profile !== null ? (
            <BudgetTabActions
              key={state.vault}
              vault={state.vault}
              slug={state.profile.slug}
              profileName={
                state.profiles.find((profile) => profile.vault === state.vault)?.displayName ?? ""
              }
            />
          ) : undefined
        }
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
          <NarrowFrameContext value={{ narrow: assetPage || pageNarrow, request: setPageNarrow }}>
            <Outlet />
          </NarrowFrameContext>
        )}
      </ShellView>
      {/* Old core/App.tsx: the update card under the shell (agent C's port owns its hook). */}
      <UpdateNotice />
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
  return (
    <MinimalOverviewScreen
      today={useCalendarDay()}
      openWatchlist={() =>
        void router.navigate({
          to: "/$slug/investments.watchlist",
          params: { slug },
          search: { vault, period: "1y", view: "chart" },
        })
      }
    />
  );
}

/** A profile switch discards drawer drafts before commands can bind to the newly selected vault. */
function FullOverviewBound({ vault, slug }: { vault: string; slug: string; currency?: string }) {
  const budgetTab = (tab: string) =>
    void router.navigate({ to: "/$slug/budget/$tab", params: { slug, tab }, search: { vault } });
  return (
    <OverviewScreen
      vault={vault}
      nav={{
        openExpenses: () => budgetTab("expenses"),
        openFlows: () => budgetTab("flows"),
        openSubscriptions: () => budgetTab("subs"),
        openLoans: () =>
          void router.navigate({ to: "/$slug/loans.list", params: { slug }, search: { vault } }),
        openInvestments: () =>
          void router.navigate({
            to: "/$slug/investments.portfolio",
            params: { slug },
            search: { vault, period: "1y", view: "chart" },
          }),
        openSetup: (module) => {
          if (module === "assets")
            void router.navigate({
              to: "/$slug/setup/assets",
              params: { slug },
              search: { vault },
            });
          else if (module === "loans")
            void router.navigate({ to: "/$slug/setup/loans", params: { slug }, search: { vault } });
          else
            void router.navigate({
              to: "/$slug/setup/$module",
              params: { slug, module },
              search: { vault },
            });
        },
        openModulesSettings: () =>
          void router.navigate({
            to: "/$slug/settings",
            params: { slug },
            search: { vault, section: "modules" },
          }),
      }}
    />
  );
}

/** Old deep links to the budget module (`#/<slug>/budget`) open its first tab, Wydatki. */
const budgetIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/budget",
  beforeLoad: ({ params, search }) => {
    throw redirect({
      to: "/$slug/budget/$tab",
      params: { slug: params.slug, tab: "expenses" },
      search: { vault: (search as { vault?: string }).vault },
      replace: true,
    });
  },
});
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

/** The budget's tab bar actions (old BudgetActions): inside the proposal scope, with their own toast stack. */
function BudgetTabActions(props: { vault: string; slug: string; profileName: string }) {
  const proposals = use(ProposalNavigation);
  const enabled = useQuery(budgetModuleQuery).some(
    (module) => module.id === "budget" && module.enabled,
  );
  if (!enabled) return null;
  return (
    <ToastProvider>
      <BudgetActions
        {...props}
        onProposal={(gid) => proposals.open(gid)}
        onInstructions={() =>
          void router.navigate({
            to: "/$slug/setup/$module",
            params: { slug: props.slug, module: "budget" },
            search: { vault: props.vault },
          })
        }
      />
    </ToastProvider>
  );
}

function BudgetRoute() {
  const { privacy } = useUiEnv();
  const modules = useQuery(budgetModuleQuery);
  const budget = modules.find((module) => module.id === "budget" && module.enabled);
  const { slug, tab } = budgetRoute.useParams();
  const filters = budgetRoute.useSearch();
  const vault = useProfile();
  const today = useCalendarDay();
  if (!budget) return <p className="p-6">{S.setup}</p>;
  if (!["expenses", "flows", "subs"].includes(tab)) return <RouteFailure />;
  const change = (next: typeof filters) =>
    startTransition(() => {
      if (next.currency) budgetCurrencyByVault.set(vault, next.currency);
      void router.navigate({
        to: "/$slug/budget/$tab",
        params: { slug, tab },
        search: { ...next, vault },
      });
    });
  // An enabled budget without data: its first tab is the module's first steps (old Shell `def.Start`).
  const body =
    tab === "expenses" && budget.setupState === "empty" ? (
      <BudgetStartBound slug={slug} vault={vault} inSetupView={false} />
    ) : tab === "flows" ? (
      <FlowsScreen today={today} filters={filters} onFilters={change} />
    ) : tab === "subs" ? (
      <SubscriptionsScreen />
    ) : (
      <ExpensesScreen today={today} filters={filters} onFilters={change} />
    );
  return (
    <Page width="narrow" label={budgetTabLabel(tab)}>
      <ToastProvider>
        <Suspense fallback={<SkeletonTable rows={8} />}>
          <Fragment key={`${vault}:${privacy}`}>{body}</Fragment>
        </Suspense>
      </ToastProvider>
    </Page>
  );
}
const budgetTabLabel = (tab: string) =>
  tab === "flows" ? BI.tabFlows : tab === "subs" ? BI.tabSubs : BI.tabExpenses;

/** `setup/budget`: the budget first steps in the page box (the budget's first tab stays lit). */
function BudgetStartRoute({ slug, vault }: { slug: string; vault: string }) {
  const { privacy } = useUiEnv();
  const enabled = useQuery(budgetModuleQuery).some(
    (module) => module.id === "budget" && module.enabled,
  );
  if (!enabled) return <p className="p-6">{S.setup}</p>;
  return (
    <Page width="narrow" label={BI.name}>
      <Suspense fallback={<SkeletonTable rows={3} />}>
        <BudgetStartBound key={`${vault}:${privacy}`} slug={slug} vault={vault} inSetupView />
      </Suspense>
    </Page>
  );
}

function BudgetStartBound(props: { slug: string; vault: string; inSetupView: boolean }) {
  const today = useCalendarDay();
  const go = (to: "/$slug/budget/$tab" | "/$slug/settings") => {
    if (to === "/$slug/budget/$tab")
      void router.navigate({
        to,
        params: { slug: props.slug, tab: "expenses" },
        search: { vault: props.vault },
      });
    else
      void router.navigate({
        to,
        params: { slug: props.slug },
        search: { vault: props.vault, section: "agent" },
      });
  };
  return (
    <BudgetStartScreen
      today={today}
      slug={props.slug}
      inSetupView={props.inSetupView}
      onExpenses={() => go("/$slug/budget/$tab")}
      onAgentSettings={() => go("/$slug/settings")}
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
/** The old `/cli` guide of a module: its first steps now carry the Claude Code card on one page. */
const setupGuideRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/setup/$module/cli",
  validateSearch: (raw) => search.pick({ vault: true }).parse(raw),
  beforeLoad: ({ params, search: query }) => {
    throw redirect({
      to: "/$slug/setup/$module",
      params,
      search: { vault: query.vault },
      replace: true,
    });
  },
  errorComponent: RouteFailure,
});
const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/setup/$module",
  validateSearch: (raw) => search.pick({ vault: true }).parse(raw),
  // Loans and assets have their own routes; any other module id is not a module: Przegląd.
  beforeLoad: ({ params, search: query }) => {
    if (params.module !== "budget" && params.module !== "investments")
      throw redirect({
        to: "/$slug/overview",
        params: { slug: params.slug },
        search: { vault: query.vault },
        replace: true,
      });
  },
  component: SetupRoute,
  pendingComponent: () => (
    <p role="status" className="p-6">
      {S.waiting}
    </p>
  ),
  errorComponent: RouteFailure,
});
/** `setup/<module>` (loans and assets have their own routes): the module's first steps with the Claude Code card. */
function SetupRoute() {
  const { slug, module } = useParams({ strict: false });
  const vault = useProfile();
  if (module === "budget") return <BudgetStartRoute slug={slug ?? ""} vault={vault} />;
  return <PortfolioRoute setup />;
}
function LoansRoute() {
  return <LoansBody slug={loansRoute.useParams().slug} setup={false} />;
}
function LoansSetupRoute() {
  return <LoansBody slug={loansSetupRoute.useParams().slug} setup />;
}
/** Kredyty (old loans tab and `setup/loans` Start) with its links: first steps, the CLI guide, Agent AI. */
function LoansBody({ slug, setup }: { slug: string; setup: boolean }) {
  const vault = useProfile();
  const enabled = useQuery(budgetModuleQuery).some(
    (module) => module.id === "loans" && module.enabled,
  );
  if (!enabled) return <p className="p-6">{S.setup}</p>;
  return (
    <LoansScreen
      setup={setup}
      onSetup={() =>
        void router.navigate({ to: "/$slug/setup/loans", params: { slug }, search: { vault } })
      }
      onAgentSettings={() =>
        void router.navigate({
          to: "/$slug/settings",
          params: { slug },
          search: { vault, section: "agent" },
        })
      }
    />
  );
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
      onAgentSettings={() => {
        void router.navigate({
          to: "/$slug/settings",
          params: { slug },
          search: { vault, section: "agent" },
        });
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
  /** The header tag's `?alloc=accounts&t=`: Alokacja on its Rachunki view, `t` a fresh request per click. */
  alloc: z.literal("accounts").optional(),
  t: z.number().int().optional(),
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
  /** Old `alerts?edit=<id>`: the alert in the edit form. */
  edit: investmentEntityIdSchema.optional(),
});
/** The investments routes' pending state: the Home skeleton, in the 1120px frame for the asset page. */
function InvestmentsPending() {
  const page = useLocation({
    select: (l) => String((l.search as { page?: unknown }).page ?? "") === "1",
  });
  return <InvestmentsHomeLoading narrow={page} />;
}
const portfolioRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/investments.portfolio",
  validateSearch: (raw) => investmentSearch.parse(raw),
  component: PortfolioRoute,
  pendingComponent: InvestmentsPending,
  errorComponent: RouteFailure,
});
const investmentAssetRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/assets/$instrument",
  validateSearch: (raw) => investmentSearch.parse(raw),
  component: PortfolioRoute,
  pendingComponent: InvestmentsPending,
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
// Old sub-route `watch`: the Home with Aktywa on the Obserwowane tab and the instrument search open.
const watchlistRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/$slug/investments.watchlist",
  validateSearch: (raw) => investmentSearch.parse(raw),
  component: PortfolioRoute,
  pendingComponent: InvestmentsPending,
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
  const page = pathname.endsWith("investments.alerts") ? "alerts" : "journal";
  return (
    <SignalsPageScreen
      page={page}
      initialInstrument={selected.instrument}
      initialEdit={page === "alerts" ? (selected.edit ?? null) : null}
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
/** The investments Home; `setup` = `setup/investments`: its first steps even when the portfolio has data. */
function PortfolioRoute({ setup = false }: { setup?: boolean }) {
  const { slug, instrument } = useParams({ strict: false });
  const selected = useSearch({ strict: false }) as z.infer<typeof investmentSearch>;
  const vault = useProfile();
  const modules = useQuery(overviewQueries({ prices: null }).moduleStates);
  const proposals = use(ProposalNavigation);
  const notificationSignal = use(NotificationSignalFocus);
  // `investments.research`: the research page in place of the Home grid (old sub-route `research`).
  const research = useLocation({ select: (l) => l.pathname.endsWith("/investments.research") });
  const watch = useLocation({ select: (l) => l.pathname.endsWith("/investments.watchlist") });
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
      watch={watch}
      allocRequest={selected.alloc === "accounts" ? (selected.t ?? 0) : null}
      slug={slug ?? ""}
      setup={setup}
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
    budgetIndexRoute,
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
