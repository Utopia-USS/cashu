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
  children: ReactNode;
}

// Navigation order of the Python app (core/registry.ts MODULES): budget | loans | assets | investments,
// each module its own group after Przegląd. Settings lives in the profile menu, as there.
const MODULE_TABS = [
  ["budget", () => S.budget],
  ["loans", () => S.loans],
  ["assets", () => S.assets],
  ["investments", () => S.investments],
] as const;

// Przegląd and the investments workspace use the wide page (old `.wrap.wide`), everything else 1120px.
const WIDE = new Set(["overview", "investments"]);

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
    ...MODULE_TABS.filter(([id]) => state.enabledModules.includes(id)).map(([id, label]) => {
      const pending = state.pendingModules.includes(id);
      return [
        {
          id,
          label: label(),
          current: activeModule === id,
          onPress: () => onModuleOpened(id),
          pending,
          pendingTitle: T.notConfiguredTitle,
        },
      ];
    }),
  ];
  return (
    <UiEnvProvider privacy={state.privacy} locale={state.locale}>
      <div className="min-h-screen bg-surface text-body text-fg">
        <div className={`mx-auto px-5 pt-6 ${WIDE.has(activeModule) ? "max-w-360" : "max-w-280"}`}>
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
                disabled={state.isSwitching}
              />
            }
            actions={
              <IconToggle
                checked={state.privacy}
                onChange={state.onPrivacyChanged}
                label={S.privacy}
                title={state.privacy ? T.showAmounts : S.privacy}
              >
                <EyeGlyph crossed={state.privacy} />
              </IconToggle>
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
          <TabBar label={S.modules} groups={groups} />
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
