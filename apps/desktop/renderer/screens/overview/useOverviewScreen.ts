// The Przegląd screen hook (ab24ab6 core/Overview.tsx with its widgets): the native overview reads, the UI
// state of the widgets (chart mode / scope / step / range, empty accounts, hidden module cards) and the widget
// models in the old slot order. The investments widgets get their old-shape data from useOverviewInvestments,
// which the screen mounts only while the investments module is set up.
import type { IsoDate } from "@cashu/domain";
import { lang } from "@cashu/i18n";
import { S as AI } from "@cashu/i18n/assets/index.strings";
import { S as BI } from "@cashu/i18n/budget/index.strings";
import { S as II } from "@cashu/i18n/investments/index.strings";
import { S as L } from "@cashu/i18n/loans/index.strings";
import { overviewQueries } from "@cashu/store/overview";
import { useQuery } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { useState } from "react";
import { type ChartMode, netWorthModel, type Scope, type Step } from "./netWorthModel.js";
import {
  accountsModel,
  budgetMonthModel,
  heroModel,
  loansModel,
  pendingModel,
  type RichFact,
  subscriptionsModel,
} from "./overviewModel.js";
import { useAccountRemoval } from "./useAccountRemoval.js";

const queries = overviewQueries({ prices: null });
const MODULE_NAME: Readonly<Record<string, () => string>> = {
  budget: () => BI.name,
  assets: () => AI.name,
  loans: () => L.title,
  investments: () => II.name,
};

export interface OverviewNavigation {
  openExpenses(): void;
  openSubscriptions(): void;
  openFlows(): void;
  openLoans(): void;
  openInvestments(): void;
  openSetup(module: string): void;
  openModulesSettings(): void;
}

export function useOverviewScreen(args: {
  today: IsoDate;
  vault: string;
  nav: OverviewNavigation;
  wallet: { exists: boolean; balance: import("@cashu/domain").Decimal; currency: string };
  onCash(): void;
  /** The investments hero fact (null while the module is off or empty). */
  investmentsFact: RichFact | null;
}) {
  const { privacy } = useUiEnv();
  const language = lang();
  const [mode, setMode] = useState<ChartMode>("line");
  const [scope, setScope] = useState<Scope>("total");
  const [step, setStep] = useState<Step>("monthly");
  const [range, setRange] = useState<number | null>(null);
  const [showEmpty, setShowEmpty] = useState(false);
  const removal = useAccountRemoval();
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const hero = useQuery(queries.hero, { today: args.today });
  const modules = useQuery(queries.moduleStates).filter((m) => m.enabled);
  const setups = {
    budget: useQuery(queries.moduleSetup, { module: "budget", cli: "", lang: language }),
    loans: useQuery(queries.moduleSetup, { module: "loans", cli: "", lang: language }),
    investments: useQuery(queries.moduleSetup, { module: "investments", cli: "", lang: language }),
  };
  const accounts = useQuery(queries.accounts, { today: args.today });
  const budget = useQuery(queries.budgetWidgets, { today: args.today });
  const loans = useQuery(queries.loans, { today: args.today });
  const currency = hero.facts.currency;
  // Every other currency converted into the headline one at each day's NBP rate (the owner's choice).
  const seriesArgs = { today: args.today, lang: language, currency, convert: true };
  const series = useQuery(queries.netWorthSeries, { ...seriesArgs, granularity: step, scope });
  const total = useQuery(queries.netWorthSeries, {
    ...seriesArgs,
    granularity: "monthly",
    scope: "total",
  });
  const liquid = useQuery(queries.netWorthSeries, {
    ...seriesArgs,
    granularity: "monthly",
    scope: "liquid",
  });

  const state = (id: string) => modules.find((m) => m.id === id)?.setupState ?? null;
  const on = (id: string) => state(id) !== null;
  const setUp = (id: string) => on(id) && state(id) !== "empty";
  const hiddenKey = (id: string, s: string) => `cashu.overview.hidden.${args.vault}.${id}.${s}`;
  const isHidden = (key: string) => {
    if (hiddenKeys.has(key)) return true;
    try {
      return typeof localStorage !== "undefined" && localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  };
  const hide = (id: string, s: string) => {
    const key = hiddenKey(id, s);
    try {
      localStorage.setItem(key, "1");
    } catch {
      /* storage unavailable: hidden for this visit only */
    }
    setHiddenKeys((prior) => new Set([...prior, key]));
  };
  // A module whose widget is its own first steps (Majątek) never gets the pending card.
  const pending = modules
    .filter((m) => m.setupState !== "ready" && m.id !== "assets")
    .filter((m) => !isHidden(hiddenKey(m.id, m.setupState)))
    .map((m) => {
      const r = setups[m.id as keyof typeof setups];
      return pendingModel({
        id: m.id,
        name: MODULE_NAME[m.id]?.() ?? m.id,
        state: m.setupState,
        steps: r?.ok ? r.value.steps : null,
        onHide: () => hide(m.id, m.setupState),
        onContinue: () => args.nav.openSetup(m.id),
      });
    });

  return {
    today: args.today,
    privacy,
    noModules: modules.length === 0,
    show: {
      budget: setUp("budget"),
      surplus: setUp("investments") && on("budget"),
      investments: setUp("investments"),
      assets: on("assets"),
      loans: setUp("loans"),
    },
    hero: heroModel({
      facts: hero.facts,
      converted: hero.converted,
      change: hero.change,
      norm: hero.norm,
      modules: modules.length,
      investments: args.investmentsFact,
    }),
    budget: budgetMonthModel(budget, args.nav.openExpenses),
    subscriptions: subscriptionsModel(budget, privacy, args.nav.openSubscriptions),
    accounts: accountsModel({
      accounts,
      wallet: args.wallet,
      showEmpty,
      privacy,
      removal,
      onToggle: () => setShowEmpty((v) => !v),
      onCash: args.onCash,
    }),
    pending,
    netWorth: netWorthModel({
      series,
      total,
      liquid,
      ui: { mode, setMode, scope, setScope, step, setStep, range, setRange },
    }),
    loans: loansModel({
      loans,
      base: currency,
      norm: budget.norm,
      privacy,
      open: args.nav.openLoans,
    }),
    baseCurrency: currency,
  };
}
