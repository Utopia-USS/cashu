import { PRIVACY, S as Wizard } from "@cashu/i18n/core/Wizard.strings";
import { type FormEvent, useEffect, useRef } from "react";
import { C } from "./Creation.strings.js";
import type { CreationScreenState } from "./useCreationScreen.js";

const card = "grid gap-5 rounded-lg border border-border bg-surface-raised p-6";
const button =
  "rounded-sm border border-border bg-surface px-4 py-2 hover:bg-surface-sunken disabled:opacity-50";

export function CreationView({ state }: { state: CreationScreenState }) {
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state.phase === "profile") nameInput.current?.focus();
  }, [state.phase]);
  const stageText: Record<string, string> = {
    recorded: C.stageRecorded,
    keys: C.stageKeys,
    artifacts: C.stageArtifacts,
    history: C.stageHistory,
    admission: C.stageAdmission,
    publishing: C.stagePublishing,
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (state.phase === "privacy") state.onPrepare();
    else state.onNext();
  };
  return (
    <main
      className={state.mode === "first" ? "min-h-screen bg-surface p-6 text-fg" : "p-6 text-fg"}
      data-testid="native-creation"
      onKeyDown={(event) => {
        if (event.key === "Escape" && state.canClose && state.onClosed) {
          event.preventDefault();
          state.onClosed();
        }
      }}
    >
      <div
        className="mx-auto grid max-w-2xl gap-5"
        role="dialog"
        aria-modal={state.mode === "additional" ? true : undefined}
        aria-label={state.mode === "additional" ? Wizard.newProfile : Wizard.welcome}
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-headline font-strong">
              {state.mode === "first" ? Wizard.welcome : Wizard.newProfile}
            </h1>
            <p className="text-fg-muted">{Wizard.leadLocal}</p>
          </div>
          {state.mode === "additional" && state.canClose && state.onClosed && (
            <button type="button" className={button} onClick={state.onClosed}>
              {Wizard.closeEsc}
            </button>
          )}
        </header>
        {state.phase === "checking" && <p role="status">{C.checking}</p>}
        {state.phase === "unavailable" && <p role="alert">{C.unavailable}</p>}
        {state.phase === "refused" && (
          <section className={card} role="alert">
            <p>{state.refusal === "prepare_expired" ? C.expired : C.refused}</p>
            <button type="button" className={button} onClick={state.onCheckStatus}>
              {C.checkStatus}
            </button>
          </section>
        )}
        {(["profile", "modules", "privacy"] as const).includes(
          state.phase as "profile" | "modules" | "privacy",
        ) && (
          <form className={card} onSubmit={submit}>
            <p className="text-caption text-fg-muted">
              {state.phase === "profile"
                ? Wizard.stepOf(1)
                : state.phase === "modules"
                  ? Wizard.stepOf(2)
                  : Wizard.stepOf(3)}
            </p>
            {state.phase === "profile" && (
              <>
                <label className="grid gap-1">
                  {Wizard.profileName}
                  <input
                    ref={nameInput}
                    name="profileName"
                    required
                    maxLength={40}
                    value={state.values.name}
                    onChange={(event) => state.onNameChanged(event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                </label>
                <label className="grid gap-1">
                  {Wizard.baseCurrency}
                  <select
                    value={state.values.baseCurrency}
                    onChange={(event) => state.onCurrencyChanged(event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  >
                    {(["PLN", "EUR", "USD", "CHF", "GBP"] as const).map((currency) => (
                      <option key={currency} value={currency}>
                        {currency}
                      </option>
                    ))}
                  </select>
                  <small className="text-fg-muted">{Wizard.baseCurrencyTitle}</small>
                </label>
                <label className="grid gap-1">
                  {C.deviceAlias}
                  <input
                    maxLength={40}
                    value={state.values.deviceAlias}
                    onChange={(event) => state.onDeviceAliasChanged(event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                  <small className="text-fg-muted">{C.deviceAliasHint}</small>
                </label>
              </>
            )}
            {state.phase === "modules" && (
              <>
                <h2 className="text-title">{Wizard.modules}</h2>
                <p className="text-caption text-fg-muted">{Wizard.noModulesHint}</p>
                {state.modules.map((module) => (
                  <label key={module.id} className="flex gap-3 rounded-sm border border-border p-3">
                    <input
                      type="checkbox"
                      checked={module.selected}
                      disabled={!module.available}
                      onChange={() => state.onModuleToggled(module.id)}
                    />
                    <span className="grid gap-1">
                      <strong>{module.name}</strong>
                      <span className="text-caption text-fg-muted">{module.description}</span>
                      {!module.available && <span>{Wizard.soon}</span>}
                      {module.dependsOn.length > 0 && (
                        <span className="text-caption text-fg-muted">
                          {Wizard.requires(module.dependsOn.join(", "))}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </>
            )}
            {state.phase === "privacy" && (
              <>
                <h2 className="text-title">{PRIVACY.question}</h2>
                <p className="text-caption text-fg-muted">{PRIVACY.common}</p>
                {PRIVACY.options.map((option) => (
                  <label
                    key={option.value}
                    className="flex gap-3 rounded-sm border border-border p-3"
                  >
                    <input
                      type="radio"
                      name="mcpPrivacy"
                      checked={state.values.mcpPrivacy === option.value}
                      onChange={() => state.onPrivacyPicked(option.value)}
                    />
                    <span className="grid gap-1">
                      <strong>{option.title}</strong>
                      <span>{option.desc}</span>
                      <small className="text-fg-muted">{option.example}</small>
                    </span>
                  </label>
                ))}
                <div className="grid gap-1 border-t border-border pt-4">
                  <h3>{Wizard.summary}</h3>
                  <p>
                    {Wizard.profile}: {state.values.name.trim()} · {state.values.baseCurrency}
                  </p>
                  <p>
                    {Wizard.modules}:{" "}
                    {state.modules
                      .filter((module) => module.selected)
                      .map((module) => module.name)
                      .join(", ") || Wizard.noModules}
                  </p>
                  <label className="flex gap-3">
                    <input
                      type="checkbox"
                      checked={state.workspaceEnabled}
                      onChange={(event) => state.onWorkspaceEnabled(event.target.checked)}
                    />
                    <span>{C.workspaceChoice}</span>
                  </label>
                  <small className="text-fg-muted">{C.workspaceChoiceHint}</small>
                </div>
                {state.refusal && <p role="alert">{C.refused}</p>}
              </>
            )}
            <div className="flex justify-between gap-3">
              {state.phase !== "profile" ? (
                <button type="button" className={button} onClick={state.onBack}>
                  {Wizard.back}
                </button>
              ) : (
                <span />
              )}
              <button
                type="submit"
                className={button}
                disabled={state.phase === "privacy" && state.values.mcpPrivacy === null}
              >
                {state.phase === "privacy" ? C.recoveryTitle : Wizard.next}
              </button>
            </div>
          </form>
        )}
        {state.phase === "preparing" && <p role="status">{C.preparing}</p>}
        {state.phase === "recovery" && (
          <section className={card}>
            <h2 className="text-title">{C.recoveryTitle}</h2>
            <p>{C.recoveryHint}</p>
            <p
              className="rounded-sm border border-border bg-surface p-4 font-mono leading-loose"
              data-testid="recovery-phrase"
            >
              {state.phrase}
            </p>
            <label className="flex gap-3">
              <input
                type="checkbox"
                checked={state.backupConfirmed}
                onChange={(event) => state.onBackupConfirmed(event.target.checked)}
              />
              {C.backupConfirmed}
            </label>
            <button
              type="button"
              className={button}
              disabled={!state.backupConfirmed}
              onClick={state.onCommit}
            >
              {C.commit}
            </button>
          </section>
        )}
        {state.phase === "committing" && <p role="status">{C.committing}</p>}
        {state.phase === "verifying" && <p role="status">{C.verifying}</p>}
        {state.phase === "workspace_checking" && <p role="status">{C.workspaceChecking}</p>}
        {state.phase === "workspace_applying" && <p role="status">{C.workspaceApplying}</p>}
        {(
          [
            "workspace_ready",
            "workspace_failed",
            "workspace_unknown",
            "workspace_unavailable",
          ] as const
        ).includes(
          state.phase as
            | "workspace_ready"
            | "workspace_failed"
            | "workspace_unknown"
            | "workspace_unavailable",
        ) && (
          <section className={card} role="status">
            <h2 className="text-title">{C.workspaceChoice}</h2>
            {state.phase === "workspace_unavailable" && <p>{C.workspaceUnavailable}</p>}
            {state.phase === "workspace_failed" && <p>{C.workspaceFailed}</p>}
            {state.phase === "workspace_unknown" && <p>{C.workspaceUnknown}</p>}
            {state.workspaceStatus?.availability === "ready" && (
              <>
                <label className="grid gap-1">
                  {C.workspacePath}
                  <input
                    data-testid="workspace-path"
                    value={state.workspacePath}
                    onChange={(event) => state.onWorkspacePathChanged(event.target.value)}
                    className="rounded-sm border border-border bg-surface p-2"
                  />
                  <small className="text-fg-muted">
                    {C.workspaceDefault}: {state.workspaceStatus.defaultPath}
                  </small>
                </label>
                {state.values.modules.includes("investments") && (
                  <label className="flex gap-3">
                    <input
                      type="checkbox"
                      checked={state.routinePermissions}
                      onChange={(event) => state.onRoutinePermissionsChanged(event.target.checked)}
                    />
                    {C.workspaceRoutine}
                  </label>
                )}
              </>
            )}
            <div className="flex gap-3">
              {(state.phase === "workspace_ready" || state.phase === "workspace_failed") &&
                state.workspaceStatus?.availability === "ready" && (
                  <button
                    type="button"
                    className={button}
                    disabled={!state.workspaceInspected}
                    onClick={state.onWorkspaceApply}
                  >
                    {state.phase === "workspace_ready" ? C.workspaceApply : C.workspaceRetry}
                  </button>
                )}
              {(state.phase === "workspace_unknown" || state.phase === "workspace_unavailable") && (
                <button type="button" className={button} onClick={state.onWorkspaceInspect}>
                  {C.workspaceCheck}
                </button>
              )}
              <button type="button" className={button} onClick={state.onWorkspaceSkip}>
                {C.workspaceSkip}
              </button>
            </div>
          </section>
        )}
        {(state.phase === "pending" || state.phase === "unknown") && (
          <section className={card} role="status">
            <p>{state.phase === "pending" ? C.pending : C.unknown}</p>
            {state.stage && <p className="text-fg-muted">{stageText[state.stage]}</p>}
            <button
              type="button"
              className={button}
              disabled={state.checkingStatus}
              onClick={state.onCheckStatus}
            >
              {state.checkingStatus ? C.checkingStatus : C.checkStatus}
            </button>
          </section>
        )}
        {state.phase === "restart_possible" && (
          <section className={card} role="status">
            <p>{C.restartPossible}</p>
            <button type="button" className={button} onClick={state.onRestart}>
              {C.restart}
            </button>
          </section>
        )}
        {state.phase === "ready" && <p role="status">{C.ready}</p>}
      </div>
    </main>
  );
}
