// Contracts between the shell (core) and the frontend modules (modules/<id>/).
import type { ComponentType, ReactNode } from "react";
import type { Category, NetworthResp, Profile, SetupState, Summary } from "./api";

/** What the shell shows below the tabbar. Tab keys: "overview" or "<module>.<tab>". */
export type View =
  | { kind: "tab"; tab: string; sub?: string }
  | { kind: "setup"; module: string }
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
  go: (v: View) => void;
  /** Reload the shell's shared data (summary, net worth) and remount the page. */
  refresh: () => void;
  /** Page inside the tab ("alerts", "assets/306"); undefined = the tab's home. */
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
  /** Two sentences at the top of the SetupPage. */
  intro: string;
  /** Claude Code card: what the setup skill does ("{skill}" is replaced by its name), and a hint under the run command. */
  skillBlurb?: string;
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
  Widget: ComponentType<{ ctx: ModuleCtx }>;
}
