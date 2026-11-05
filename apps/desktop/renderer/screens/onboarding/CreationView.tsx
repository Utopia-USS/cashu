import { PRIVACY, S as Wizard } from "@cashu/i18n/core/Wizard.strings";
import { Button, Card, Modal, Select, TextField } from "@cashu/ui";
import { type FormEvent, useEffect, useId, useRef } from "react";
import { C } from "./Creation.strings.js";
import type { CreationScreenState } from "./useCreationScreen.js";

export function CreationView({ state }: { state: CreationScreenState }) {
  const nameInput = useRef<HTMLInputElement>(null);
  const hintId = useId();
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
  const content = (
    <main
      className={state.mode === "first" ? "min-h-screen bg-surface p-6 text-fg" : "p-6 text-fg"}
      aria-label={state.mode === "first" ? Wizard.welcome : undefined}
      data-testid="native-creation"
    >
      <div className="mx-auto grid max-w-2xl gap-5">
        <header className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-headline font-strong">
              {state.mode === "first" ? Wizard.welcome : Wizard.newProfile}
            </h1>
            <p className="text-fg-muted">{Wizard.leadLocal}</p>
          </div>
          {state.mode === "additional" && state.canClose && state.onClosed && (
            <Button onPress={state.onClosed}>{Wizard.closeEsc}</Button>
          )}
        </header>
        {state.phase === "checking" && <p role="status">{C.checking}</p>}
        {state.phase === "unavailable" && <p role="alert">{C.unavailable}</p>}
        {state.phase === "refused" && (
          <Card role="alert" padding="lg" className="grid gap-5">
            <p>{state.refusal === "prepare_expired" ? C.expired : C.refused}</p>
            <Button onPress={state.onCheckStatus}>{C.checkStatus}</Button>
          </Card>
        )}
        {(["profile", "modules", "privacy"] as const).includes(
          state.phase as "profile" | "modules" | "privacy",
        ) && (
          <Card as="form" onSubmit={submit} padding="lg" className="grid gap-5">
            <p className="text-caption text-fg-muted">
              {state.phase === "profile"
                ? Wizard.stepOf(1)
                : state.phase === "modules"
                  ? Wizard.stepOf(2)
                  : Wizard.stepOf(3)}
            </p>
            {state.phase === "profile" && (
              <>
                <TextField
                  ref={nameInput}
                  label={Wizard.profileName}
                  name="profileName"
                  required
                  maxLength={40}
                  value={state.values.name}
                  onChange={(value) => state.onNameChanged(value)}
                />
                <div className="grid gap-1">
                  <Select
                    label={Wizard.baseCurrency}
                    describedBy={`${hintId}-currency`}
                    value={state.values.baseCurrency}
                    onChange={(value) => state.onCurrencyChanged(value)}
                    options={(["PLN", "EUR", "USD", "CHF", "GBP"] as const).map((currency) => ({
                      value: currency,
                      label: currency,
                    }))}
                  />
                  <small id={`${hintId}-currency`} className="text-fg-muted">
                    {Wizard.baseCurrencyTitle}
                  </small>
                </div>
                <div className="grid gap-1">
                  <TextField
                    label={C.deviceAlias}
                    describedBy={`${hintId}-alias`}
                    maxLength={40}
                    value={state.values.deviceAlias}
                    onChange={(value) => state.onDeviceAliasChanged(value)}
                  />
                  <small id={`${hintId}-alias`} className="text-fg-muted">
                    {C.deviceAliasHint}
                  </small>
                </div>
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
                <Button onPress={state.onBack}>{Wizard.back}</Button>
              ) : (
                <span />
              )}
              <Button
                type="submit"
                disabled={state.phase === "privacy" && state.values.mcpPrivacy === null}
              >
                {state.phase === "privacy" ? C.recoveryTitle : Wizard.next}
              </Button>
            </div>
          </Card>
        )}
        {state.phase === "preparing" && <p role="status">{C.preparing}</p>}
        {state.phase === "recovery" && (
          <Card padding="lg" className="grid gap-5">
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
            <Button disabled={!state.backupConfirmed} onPress={state.onCommit}>
              {C.commit}
            </Button>
          </Card>
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
          <Card role="status" padding="lg" className="grid gap-5">
            <h2 className="text-title">{C.workspaceChoice}</h2>
            {state.phase === "workspace_unavailable" && <p>{C.workspaceUnavailable}</p>}
            {state.phase === "workspace_failed" && <p>{C.workspaceFailed}</p>}
            {state.phase === "workspace_unknown" && <p>{C.workspaceUnknown}</p>}
            {state.workspaceStatus?.availability === "ready" && (
              <>
                <div className="grid gap-1">
                  <TextField
                    label={C.workspacePath}
                    describedBy={`${hintId}-workspace`}
                    testID="workspace-path"
                    value={state.workspacePath}
                    onChange={(value) => state.onWorkspacePathChanged(value)}
                  />
                  <small id={`${hintId}-workspace`} className="text-fg-muted">
                    {C.workspaceDefault}: {state.workspaceStatus.defaultPath}
                  </small>
                </div>
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
                  <Button disabled={!state.workspaceInspected} onPress={state.onWorkspaceApply}>
                    {state.phase === "workspace_ready" ? C.workspaceApply : C.workspaceRetry}
                  </Button>
                )}
              {(state.phase === "workspace_unknown" || state.phase === "workspace_unavailable") && (
                <Button onPress={state.onWorkspaceInspect}>{C.workspaceCheck}</Button>
              )}
              <Button onPress={state.onWorkspaceSkip}>{C.workspaceSkip}</Button>
            </div>
          </Card>
        )}
        {(state.phase === "pending" || state.phase === "unknown") && (
          <Card role="status" padding="lg" className="grid gap-5">
            <p>{state.phase === "pending" ? C.pending : C.unknown}</p>
            {state.stage && <p className="text-fg-muted">{stageText[state.stage]}</p>}
            <Button disabled={state.checkingStatus} onPress={state.onCheckStatus}>
              {state.checkingStatus ? C.checkingStatus : C.checkStatus}
            </Button>
          </Card>
        )}
        {state.phase === "restart_possible" && (
          <Card role="status" padding="lg" className="grid gap-5">
            <p>{C.restartPossible}</p>
            <Button onPress={state.onRestart}>{C.restart}</Button>
          </Card>
        )}
        {state.phase === "ready" && <p role="status">{C.ready}</p>}
      </div>
    </main>
  );
  if (state.mode !== "additional") return content;
  return (
    <Modal
      label={Wizard.newProfile}
      placement="screen"
      onClose={() => {
        if (state.canClose) state.onClosed?.();
      }}
    >
      {content}
    </Modal>
  );
}
