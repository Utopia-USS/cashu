// The new-profile wizard (ab24ab6 core/Wizard.tsx): Profil -> Moduły -> Prywatność (+ the agent workspace), full
// page on the first launch, over the dimmed app otherwise. Native steps keep their place in the same card: the
// device name next to the profile fields, the recovery phrase after the privacy step, the host's progress and the
// workspace created after the profile. Pure view.
import { PRIVACY, S as Wizard } from "@cashu/i18n/core/Wizard.strings";
import { WS } from "@cashu/i18n/core/workspace.strings";
import {
  Button,
  ChoiceCard,
  ChoiceCards,
  FieldNote,
  FormRow,
  KeyValues,
  Notice,
  RadioList,
  Select,
  Switch,
  Tag,
  TextField,
  WizardFrame,
} from "@cashu/ui";
import { type FormEvent, type ReactNode, useEffect, useRef } from "react";
import { C } from "./Creation.strings.js";
import type { CreationScreenState } from "./useCreationScreen.js";

const CURRENCIES = ["PLN", "EUR", "USD", "CHF", "GBP"] as const;
const DOT = " · ";
type Phase = CreationScreenState["phase"];
const FORM: readonly Phase[] = ["profile", "modules", "privacy", "preparing"];
const WORKSPACE: readonly Phase[] = [
  "workspace_checking",
  "workspace_ready",
  "workspace_applying",
  "workspace_failed",
  "workspace_unknown",
  "workspace_unavailable",
];

/** The wizard's step for the stepper: the profile step until the name is in, the privacy step afterwards. */
const stepOf = (phase: Phase): number =>
  phase === "modules" ? 1 : ["checking", "unavailable", "profile"].includes(phase) ? 0 : 2;

// Old global classes: `.controls` (+ `.spacer`), muted small lines, the step's h2 (UA 1.5em bold, 8px below).
const controls = "flex flex-wrap items-center gap-2";
const muted12 = "text-xs text-fg-muted";
const muted125 = "text-xs-plus text-fg-muted";
const stepHeading = "mt-0 mb-2 text-3xl-plus font-bold";
const code = "font-mono text-code-ui [font-variant-ligatures:none]";

export function CreationView({ state }: { state: CreationScreenState }) {
  const step = stepOf(state.phase);
  const name = state.values.name.trim();
  const first = state.mode === "first";
  const title =
    step === 0 || !name
      ? first
        ? Wizard.welcome
        : Wizard.newProfile
      : Wizard.newProfileNamed(name);
  const lead = FORM.includes(state.phase)
    ? [first ? Wizard.leadLocal : null, Wizard.leadLater, Wizard.leadMcp][step]
    : null;
  return (
    <WizardFrame
      mode={first ? "page" : "overlay"}
      label={first ? Wizard.welcome : Wizard.newProfile}
      title={title}
      lead={lead}
      steps={[Wizard.stepProfile, Wizard.stepModules, Wizard.stepPrivacy]}
      current={step}
      onClose={state.mode === "additional" && state.canClose ? state.onClosed : undefined}
      testID="native-creation"
    >
      {FORM.includes(state.phase) ? (
        <StepForm state={state} step={step} />
      ) : state.phase === "recovery" || state.phase === "committing" ? (
        <Recovery state={state} />
      ) : WORKSPACE.includes(state.phase) ? (
        <WorkspaceStep state={state} />
      ) : (
        <Progress state={state} />
      )}
    </WizardFrame>
  );
}

function StepForm({ state, step }: { state: CreationScreenState; step: number }) {
  const busy = state.phase === "preparing";
  const picked = state.modules.filter((module) => module.selected);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (step === 2) state.onPrepare();
    else state.onNext();
  };
  return (
    <form onSubmit={submit} noValidate>
      {step === 0 && <ProfileStep state={state} />}
      {step === 1 && (
        <ChoiceCards>
          {state.modules.map((module) => (
            <ChoiceCard
              key={module.id}
              checked={module.selected}
              disabled={!module.available}
              title={module.name}
              tag={!module.available ? <Tag>{Wizard.soon}</Tag> : undefined}
              desc={module.description}
              hint={
                module.dependsOn.length ? Wizard.requires(module.dependsOn.join(", ")) : undefined
              }
              onChange={() => state.onModuleToggled(module.id)}
            />
          ))}
        </ChoiceCards>
      )}
      {step === 2 && <PrivacyStep state={state} busy={busy} />}
      <div className={`${controls} mt-4.5`}>
        {step > 0 && (
          <Button onPress={state.onBack} disabled={busy}>
            {Wizard.back}
          </Button>
        )}
        <span className={muted12}>
          {Wizard.stepOf(step + 1)}
          {step === 1 && Wizard.picked(state.pickedText)}
        </span>
        <span className="flex-1" />
        {step === 1 && !picked.length && <span className={muted12}>{Wizard.noModulesHint}</span>}
        {step === 2 && !state.values.mcpPrivacy && (
          <span className={muted12}>{Wizard.choosePrivacy}</span>
        )}
        <Button
          variant="primary"
          type="submit"
          disabled={busy || (step === 2 && state.values.mcpPrivacy === null)}
        >
          {busy ? C.preparing : Wizard.next}
        </Button>
      </div>
    </form>
  );
}

function ProfileStep({ state }: { state: CreationScreenState }) {
  const nameInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    nameInput.current?.focus();
  }, []);
  return (
    <FormRow>
      <TextField
        ref={nameInput}
        label={Wizard.profileName}
        name="profileName"
        maxLength={40}
        autoComplete="off"
        invalid={!!state.nameError}
        value={state.values.name}
        onChange={state.onNameChanged}
        className="mb-3"
        after={state.nameError ? <FieldNote tone="negative">{state.nameError}</FieldNote> : null}
      />
      <Select
        label={Wizard.baseCurrency}
        title={Wizard.baseCurrencyTitle}
        value={state.values.baseCurrency}
        onChange={state.onCurrencyChanged}
        options={CURRENCIES.map((currency) => ({ value: currency, label: currency }))}
        className="mb-3"
      />
      <TextField
        label={C.deviceAlias}
        title={C.deviceAliasHint}
        maxLength={40}
        autoComplete="off"
        value={state.values.deviceAlias}
        onChange={state.onDeviceAliasChanged}
        className="mb-3"
      />
    </FormRow>
  );
}

function PrivacyStep({ state, busy }: { state: CreationScreenState; busy: boolean }) {
  const privacy = state.values.mcpPrivacy;
  const name = state.values.name.trim();
  const modules = state.modules.filter((module) => module.selected).map((module) => module.name);
  const rows: { key: string; label: string; value: ReactNode }[] = [
    { key: "profile", label: Wizard.profile, value: `${name}${DOT}${state.values.baseCurrency}` },
    { key: "modules", label: Wizard.modules, value: modules.join(", ") || Wizard.noModules },
    {
      key: "agent",
      label: Wizard.agent,
      value:
        privacy === "strict" ? (
          <span>
            {Wizard.strictLevel}
            <span className="text-fg-muted">{Wizard.strictLevelHint}</span>
          </span>
        ) : privacy === "amounts" ? (
          <span>
            {Wizard.amountsLevel}
            <span className="text-fg-muted">{Wizard.amountsLevelHint}</span>
          </span>
        ) : (
          <span className="text-fg-muted">{Wizard.toChoose}</span>
        ),
    },
    ...(state.values.deviceAlias.trim()
      ? [{ key: "device", label: C.deviceAlias, value: state.values.deviceAlias.trim() }]
      : []),
    {
      key: "workspace",
      label: Wizard.workspace,
      value: state.workspaceEnabled ? (
        <code className={`${code} text-sm`}>{Wizard.defaultFolder}</code>
      ) : (
        <span className="text-sm">{Wizard.skipped}</span>
      ),
    },
  ];
  return (
    <>
      <h2 className={stepHeading}>{PRIVACY.question}</h2>
      <RadioList
        name="mcpPrivacy"
        label={PRIVACY.question}
        value={privacy}
        onChange={state.onPrivacyPicked}
        disabled={busy}
        options={PRIVACY.options.map((option) => ({
          value: option.value,
          title: option.title,
          desc: option.desc,
          tooltip: option.example,
        }))}
      />
      <div className={`${muted125} mt-1 mb-4`}>
        {PRIVACY.common} {WS.proposalNote}
      </div>
      <section className="mb-4" aria-labelledby="wz-ws-h">
        <div className={`${controls} mb-1.5`}>
          <Switch
            on={state.workspaceEnabled}
            label={Wizard.createWorkspace}
            onChange={state.onWorkspaceEnabled}
            disabled={busy}
          />
          <strong id="wz-ws-h" className="text-md" title={Wizard.workspaceTitle}>
            {Wizard.workspaceHeading}
          </strong>
        </div>
        <div className={`${muted125} mb-2`}>{Wizard.workspaceDesc}</div>
        {!state.workspaceEnabled && <div className={muted125}>{Wizard.workspaceLater}</div>}
      </section>
      <section className="rounded-widget bg-chip px-3.5 py-3" aria-labelledby="wz-summary-h">
        <h2
          id="wz-summary-h"
          className="mt-0 mb-2 text-md font-bold uppercase tracking-caps text-fg-muted"
        >
          {Wizard.summary}
        </h2>
        <KeyValues keyWidth="narrow" rows={rows} />
      </section>
      {state.refusal && (
        <Notice tone="negative" role="alert" className="mt-3.5 mb-0">
          {C.refused}
        </Notice>
      )}
    </>
  );
}

function Recovery({ state }: { state: CreationScreenState }) {
  const busy = state.phase === "committing";
  return (
    <>
      <h2 className={stepHeading}>{C.recoveryTitle}</h2>
      <p className={`${muted125} mt-0 mb-3`}>{C.recoveryHint}</p>
      {!busy && (
        <p
          className="mt-0 mb-3 rounded-control border border-border bg-chip px-3 py-2.5 font-mono text-sm leading-loose [font-variant-ligatures:none]"
          data-testid="recovery-phrase"
        >
          {state.phrase}
        </p>
      )}
      <label className={`${controls} text-sm`}>
        <input
          type="checkbox"
          className="accent-accent"
          checked={state.backupConfirmed}
          disabled={busy}
          onChange={(event) => state.onBackupConfirmed(event.target.checked)}
        />
        {C.backupConfirmed}
      </label>
      <div className={`${controls} mt-4.5`}>
        <span className={muted12}>{Wizard.stepOf(3)}</span>
        <span className="flex-1" />
        <Button
          variant="primary"
          disabled={busy || !state.backupConfirmed}
          onPress={state.onCommit}
        >
          {busy ? C.committing : C.commit}
        </Button>
      </div>
    </>
  );
}

function WorkspaceStep({ state }: { state: CreationScreenState }) {
  const phase = state.phase;
  const ready = state.workspaceStatus?.availability === "ready" ? state.workspaceStatus : null;
  const applying = phase === "workspace_applying";
  const busy = applying || phase === "workspace_checking";
  return (
    <>
      <div className={`${controls} mb-1.5`}>
        <strong className="text-md" title={Wizard.workspaceTitle}>
          {Wizard.workspaceHeading}
        </strong>
      </div>
      <div className={`${muted125} mb-3`}>{Wizard.workspaceDesc}</div>
      {phase === "workspace_checking" && (
        <div role="status" className={`${muted125} mb-3`}>
          {C.workspaceChecking}
        </div>
      )}
      {phase === "workspace_unavailable" && (
        <Notice tone="warning">{C.workspaceUnavailable}</Notice>
      )}
      {phase === "workspace_failed" && <Notice tone="warning">{C.workspaceFailed}</Notice>}
      {phase === "workspace_unknown" && <Notice tone="warning">{C.workspaceUnknown}</Notice>}
      {ready && (
        <>
          <TextField
            label={Wizard.workspaceFolder}
            testID="workspace-path"
            value={state.workspacePath}
            placeholder={ready.defaultPath}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            onChange={state.onWorkspacePathChanged}
            className="mb-3"
            after={
              <FieldNote>
                {C.workspaceDefault}: {ready.defaultPath}
              </FieldNote>
            }
          />
          {state.values.modules.includes("investments") && (
            <>
              <div className={`${controls} mb-1 text-sm`}>
                <Switch
                  on={state.routinePermissions}
                  label={WS.routinePermissionsLabel}
                  onChange={state.onRoutinePermissionsChanged}
                  disabled={busy}
                />
                <span>{WS.routinePermissionsLabel}</span>
              </div>
              <div className={muted125}>{WS.routinePermissionsHint}</div>
            </>
          )}
        </>
      )}
      <div className={`${controls} mt-4.5`}>
        <Button onPress={state.onWorkspaceSkip} disabled={busy}>
          {C.workspaceSkip}
        </Button>
        <span className="flex-1" />
        {(phase === "workspace_ready" || phase === "workspace_failed" || applying) && ready && (
          <Button
            variant="primary"
            disabled={busy || !state.workspaceInspected}
            onPress={state.onWorkspaceApply}
          >
            {applying
              ? Wizard.creatingWorkspace
              : phase === "workspace_ready"
                ? C.workspaceApply
                : C.workspaceRetry}
          </Button>
        )}
        {(phase === "workspace_unknown" || phase === "workspace_unavailable") && (
          <Button variant="primary" onPress={state.onWorkspaceInspect}>
            {C.workspaceCheck}
          </Button>
        )}
      </div>
    </>
  );
}

const STAGE: Readonly<Record<string, string>> = {
  get recorded() {
    return C.stageRecorded;
  },
  get keys() {
    return C.stageKeys;
  },
  get artifacts() {
    return C.stageArtifacts;
  },
  get history() {
    return C.stageHistory;
  },
  get admission() {
    return C.stageAdmission;
  },
  get publishing() {
    return C.stagePublishing;
  },
};

/** The host's states around the form: checking, unavailable, refused, in progress, unknown, restart, ready. */
function Progress({ state }: { state: CreationScreenState }) {
  const phase = state.phase;
  const text =
    phase === "checking"
      ? C.checking
      : phase === "unavailable"
        ? C.unavailable
        : phase === "refused"
          ? state.refusal === "prepare_expired"
            ? C.expired
            : C.refused
          : phase === "pending"
            ? C.pending
            : phase === "unknown"
              ? C.unknown
              : phase === "restart_possible"
                ? C.restartPossible
                : phase === "verifying"
                  ? C.verifying
                  : C.ready;
  const alert = phase === "unavailable" || phase === "refused";
  const tone =
    phase === "unavailable" || phase === "refused"
      ? "negative"
      : phase === "unknown"
        ? "warning"
        : phase === "ready"
          ? "positive"
          : "info";
  return (
    <>
      <Notice tone={tone} role={alert ? "alert" : "status"} className="m-0">
        {text}
        {(phase === "pending" || phase === "unknown") && state.stage && (
          <div className={`${muted12} mt-0.5`}>{STAGE[state.stage]}</div>
        )}
      </Notice>
      {(phase === "refused" ||
        phase === "pending" ||
        phase === "unknown" ||
        phase === "restart_possible") && (
        <div className={`${controls} mt-4.5`}>
          <span className="flex-1" />
          {phase === "restart_possible" ? (
            <Button variant="primary" onPress={state.onRestart}>
              {C.restart}
            </Button>
          ) : (
            <Button variant="primary" disabled={state.checkingStatus} onPress={state.onCheckStatus}>
              {state.checkingStatus ? C.checkingStatus : C.checkStatus}
            </Button>
          )}
        </div>
      )}
    </>
  );
}
