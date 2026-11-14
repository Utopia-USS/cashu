import { S as BI } from "@cashu/i18n/budget/index.strings";
import { S as SS } from "@cashu/i18n/investments/v2/Strategies.strings";
import {
  AppHeader,
  Button,
  IconToggle,
  ProfilePill,
  type ProfilePillAction,
  TabBar,
  type TabBarTab,
  UiEnvProvider,
} from "@cashu/ui";
import type { ReactNode } from "react";
import { S } from "../Desktop.strings.js";
import logoDark from "./assets/logo-wordmark.png";
import logoLight from "./assets/logo-wordmark-light.png";
import { S as T } from "./Shell.strings.js";
import type { ShellScreenState } from "./useShellScreen.js";

export interface ShellViewProps {
  state: ShellScreenState;
  activeModule?: string;
  onOverviewOpened(): void;
  onModuleOpened(tab: string): void;
  onAddProfile?: () => void;
  /** The open module's tab bar actions after the spacer (old `TabAction`, the budget's Import / sync). */
  tabActions?: ReactNode;
  /** The modules' header tags before the privacy toggle (old `.hdr-right` `HeaderTag`: investments stale prices). */
  headerTags?: ReactNode;
  children: ReactNode;
}

// Navigation order of the Python app (core/registry.ts MODULES): budget | loans | investments, each module its
// own group after Przegląd, with its tabs (budget: Budżet, one screen for expenses, cash flow and
// subscriptions; investments: Inwestycje | Strategie). Majątek has no tab: it lives on Przegląd (its widget
// opens the Majątek page). Settings lives in the profile menu, as there.
const MODULE_TABS: readonly (readonly [string, readonly (readonly [string, () => string])[]])[] = [
  ["budget", [["budget.expenses", () => BI.tab]]],
  ["loans", [["loans", () => S.loans]]],
  [
    "investments",
    [
      ["investments", () => S.investments],
      ["investments.strategies", () => SS.tab],
    ],
  ],
];

function EyeGlyph({ crossed }: { crossed: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-4"
    >
      <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
      {crossed && <path d="M2.5 13.5l11-11" />}
    </svg>
  );
}

export function ShellView({
  state,
  onOverviewOpened,
  onModuleOpened,
  onAddProfile,
  tabActions,
  headerTags,
  children,
  activeModule = "overview",
}: ShellViewProps) {
  const actions: ProfilePillAction[] = [
    ...(onAddProfile
      ? [{ id: "new", label: T.newProfile, glyph: "add" as const, onPress: onAddProfile }]
      : []),
    {
      id: "settings",
      label: S.settings,
      glyph: "settings",
      onPress: () => onModuleOpened("settings"),
    },
  ];
  const groups: TabBarTab[][] = [
    [
      {
        id: "overview",
        label: S.overview,
        current: activeModule === "overview",
        onPress: onOverviewOpened,
      },
    ],
    ...MODULE_TABS.filter(([id]) => state.enabledModules.includes(id)).map(([module, tabs]) => {
      // The setup dot sits on the module's first tab only (old Shell.tsx `pending && i === 0`).
      const pending = state.pendingModules.includes(module);
      return tabs.map(([id, label], i) => ({
        id,
        label: label(),
        current: activeModule === id,
        onPress: () => onModuleOpened(id),
        pending: pending && i === 0,
        pendingTitle: T.notConfiguredTitle,
      }));
    }),
  ];
  return (
    <UiEnvProvider privacy={state.privacy} locale={state.locale} bananas={state.bananas}>
      <div className="min-h-screen bg-surface text-body text-fg">
        <div
          // One frame for the header on every page (the wide page box, old `.wrap.wide`): the page under it
          // picks its own width, so switching tabs never moves the logo or the tabs.
          className="mx-auto max-w-360 px-5 pt-6"
        >
          <AppHeader
            logo={{ light: logoLight, dark: logoDark, label: T.brand }}
            brand={
              <ProfilePill
                key={state.vault}
                profiles={state.profiles.map((profile) => ({
                  id: profile.vault,
                  name: profile.displayName,
                }))}
                activeId={state.vault}
                onSelect={(vault) => void state.onProfilePicked(vault)}
                actions={actions}
                title={S.profile}
                menuLabel={T.profiles}
                pending={state.isSwitching}
              />
            }
            actions={
              <>
                {headerTags}
                <IconToggle
                  checked={state.privacy}
                  onChange={state.onPrivacyChanged}
                  label={S.privacy}
                  title={state.privacyTitle}
                >
                  <EyeGlyph crossed={state.privacy} />
                </IconToggle>
              </>
            }
          />
          {/* Kept in the tree for screen readers and the live status; drawn only while not connected. */}
          <p
            role="status"
            data-testid="host-connection"
            className={state.connectionOk ? "sr-only" : "mb-2.5 text-xs text-fg-muted"}
          >
            {state.connectionText}
          </p>
          <TabBar label={S.modules} groups={groups} actions={tabActions} />
        </div>
        {state.toast !== null && (
          <div
            role="status"
            className="fixed bottom-6 left-1/2 z-100 flex max-w-11/12 -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-surface-raised px-3 py-2.5 text-sm shadow-toast"
          >
            <span>{state.toast}</span>
            <Button size="sm" onPress={state.onToastDismissed}>
              {S.dismiss}
            </Button>
          </div>
        )}
        {children}
      </div>
    </UiEnvProvider>
  );
}
