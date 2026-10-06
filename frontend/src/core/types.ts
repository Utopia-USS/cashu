// Contracts between the shell (core) and the frontend modules (modules/<id>/).
import type { ComponentType, ReactNode } from "react";
import type { Category, NetworthResp, Profile, SetupState, Summary } from "./api";

/** What the shell shows below the tabbar. Tab keys: "overview" or "<module>.<tab>". */
export type View =
  | { kind: "tab"; tab: string; sub?: string }
  | { kind: "setup"; module: string; cli?: boolean }
  | { kind: "settings"; section?: string };

/** Everything a module page or overview widget gets from the shell. */
export interface ModuleCtx {
  slug: string;
  profile: Profile;
  summary: Summary;
  networth: NetworthResp;
  categories: Category[];
  /** This module's setup state for the active profile. */
  state: SetupState;
  /** Navigate; scrolls to the top unless `scroll: false` (a redirect that keeps its place, F7 merge). */
  go: (v: View, opts?: { scroll?: boolean }) => void;
  /** Reload the shell's shared data (summary, net worth) and remount the page. */
  refresh: () => void;
  /** Page inside the tab ("alerts", "assets/306"); on Przegląd the module whose widget to focus ("assets");
   * undefined = the tab's home. */
  sub?: string;
}

export interface ModuleTab {
  id: string;
  label: string;
  render: (ctx: ModuleCtx) => ReactNode;
  /** Wide page (`.wrap.wide`, 1440 px): a workspace with a side rail (investments). */
  wide?: boolean;
}

/** One overview fact row: label, value, optional value class (pos/neg). */
export type Fact = [label: ReactNode, value: ReactNode, cls?: string];

/** Frontend half of a module (the backend half is its ModuleSpec). UI copy is Polish. */
export interface ModuleDef {
  id: string;
  name: string;
  /** Wizard choice card: description and integration hint. */
  desc: string;
  hint?: string;
  /** One line for Settings > Moduły. */
  short: string;
  /** Claude Code card: a hint under the skill's run command. */
  skillHint?: string;
  tabs: ModuleTab[];
  /** First tab shows the SetupPage while the module is `partial` too (not only `empty`). */
  setupUntilReady?: boolean;
  /** The first tab renders its own empty / setup state (e.g. an empty workspace with setup steps in
   * place of the data): the shell shows neither the SetupPage nor the partial-setup strip. */
  ownSetup?: boolean;
  /** Overview widgets: KPIs added to the core row, and facts for the module card (ready state). */
  Kpis?: ComponentType<{ ctx: ModuleCtx }>;
  Facts?: ComponentType<{ ctx: ModuleCtx }>;
  /** v2 Przegląd: widgets of a set-up module in the grid, placed by `order` among the core widgets
   * (budget month 10, surplus 20, investments 30, net worth 40, side stack 50-60, accounts 70, subscriptions 80). */
  overview?: OverviewSlot[];
  /** v2 Przegląd hero: one fact (`<Fact>` from widgets.tsx) of a set-up module. */
  HeroFact?: ComponentType<{ ctx: ModuleCtx }>;
  /** v2 Przegląd of a profile that has only this module (zero start): everything below the tabbar. */
  MinimalOverview?: ComponentType<{ ctx: ModuleCtx }>;
  /** v2 shell header (ia-v2.md 10): a data-quality tag of a set-up module, rendered only when something is
   * stale (null otherwise), e.g. "1 nieaktualna cena". */
  HeaderTag?: ComponentType<{ slug: string; go: (v: View) => void }>;
  /** "Pierwsze kroki" in the app: rendered in place of the generic SetupPage for the empty first tab and for the
   * `setup` view (the SetupPage stays reachable as `setup/<module>/cli`, design/v3/first-steps D1). */
  Start?: ComponentType<{ ctx: ModuleCtx }>;
  /** Action at the end of the tabbar while one of this module's tabs is open (budget: bank sync). */
  TabAction?: ComponentType<TabActionProps>;
}

export interface TabActionProps {
  slug: string;
  profileName: string;
  /** Null while the shell's net worth loads. */
  networth: NetworthResp | null;
  refresh: () => void;
}

/** One widget a module contributes to the v2 Przegląd grid. */
export interface OverviewSlot {
  id: string;
  span: 1 | 2 | 3;
  order: number;
  /** Consecutive span-1 slots with the same key share one column (`.stack`). */
  stack?: string;
  /** Other modules that must be enabled too (e.g. the surplus card needs the budget). */
  needs?: string[];
  /** Rendered while the module is still `empty` too (the Majątek widget is its own first steps); such a module
   * gets no PendingWidget ghost card on Przegląd. */
  whenEmpty?: boolean;
  Widget: ComponentType<{ ctx: ModuleCtx }>;
}
