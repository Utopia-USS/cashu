import { LANG_NAME, type Lang } from "@cashu/i18n";
import { UiEnvProvider } from "@cashu/ui";
import type { ReactNode } from "react";
import { S } from "../Desktop.strings.js";
import type { ShellScreenState } from "./useShellScreen.js";

export interface ShellViewProps {
  state: ShellScreenState;
  activeModule?: string;
  onOverviewOpened(): void;
  onModuleOpened(tab: string): void;
  onAddProfile?: () => void;
  children: ReactNode;
}

export function ShellView({
  state,
  onOverviewOpened,
  onModuleOpened,
  onAddProfile,
  children,
  activeModule = "overview",
}: ShellViewProps) {
  return (
    <UiEnvProvider privacy={state.privacy} locale={state.locale}>
      <div className="min-h-screen bg-surface text-body text-fg">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border bg-surface-raised px-6 py-4">
          <strong className="text-headline">cashU</strong>
          <div className="flex flex-wrap items-center gap-4">
            <label>
              {S.profile}{" "}
              <select
                aria-label={S.profile}
                value={state.vault}
                disabled={state.isSwitching}
                onChange={(event) => void state.onProfilePicked(event.target.value)}
                className="rounded-sm border border-border bg-surface p-2"
              >
                {state.profiles.map((profile) => (
                  <option key={profile.vault} value={profile.vault}>
                    {profile.displayName}
                  </option>
                ))}
              </select>
            </label>
            {onAddProfile && (
              <button
                type="button"
                onClick={onAddProfile}
                className="rounded-sm border border-border bg-surface px-4 py-2"
              >
                {S.addProfile}
              </button>
            )}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={state.privacy}
                onChange={(event) => state.onPrivacyChanged(event.target.checked)}
              />
              {S.privacy}
            </label>
            <label>
              {S.language}{" "}
              <select
                value={state.language}
                onChange={(event) => state.onLanguagePicked(event.target.value as Lang)}
                className="rounded-sm border border-border bg-surface p-2"
              >
                <option value="pl">{LANG_NAME.pl}</option>
                <option value="en">{LANG_NAME.en}</option>
              </select>
            </label>
          </div>
        </header>
        <nav
          aria-label={S.modules}
          className="flex flex-wrap gap-2 border-b border-border px-6 py-3"
        >
          <button
            type="button"
            aria-current={activeModule === "overview" ? "page" : undefined}
            onClick={onOverviewOpened}
            className={`rounded-sm px-4 py-2 ${activeModule === "overview" ? "bg-accent-muted text-accent" : "hover:bg-surface-sunken"}`}
          >
            {S.overview}
          </button>
          {(
            [
              ["budget", S.budget],
              ["investments", S.investments],
              ["assets", S.assets],
              ["loans", S.loans],
              ["settings", S.settings],
            ] as const
          )
            .filter(([id]) => id === "settings" || state.enabledModules.includes(id))
            .map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-current={activeModule === id ? "page" : undefined}
                onClick={() => onModuleOpened(id)}
                className={`rounded-sm px-4 py-2 ${activeModule === id ? "bg-accent-muted text-accent" : "hover:bg-surface-sunken"}`}
              >
                {label}
              </button>
            ))}
        </nav>
        <p
          role="status"
          data-testid="host-connection"
          className="px-6 pt-3 text-caption text-fg-muted"
        >
          {state.connectionText}
        </p>
        {state.toast !== null && (
          <div role="status" className="mx-6 mt-3 flex justify-between rounded-md bg-info-bg p-3">
            <span>{state.toast}</span>
            <button type="button" onClick={state.onToastDismissed}>
              {S.dismiss}
            </button>
          </div>
        )}
        {children}
      </div>
    </UiEnvProvider>
  );
}
