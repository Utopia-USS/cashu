// Contracts between the shell (core) and the frontend modules (modules/<id>/).
import type { ComponentType, ReactNode } from "react";
import type { Category, NetworthResp, Profile, SetupState, Summary } from "./api";

/** What the shell shows below the tabbar. Tab keys: "overview" or "<module>.<tab>". */
export type View =
  | { kind: "tab"; tab: string }
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
}
