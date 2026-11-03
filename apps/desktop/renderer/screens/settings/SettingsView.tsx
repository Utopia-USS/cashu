import { LANG_NAME } from "@cashu/i18n";
import { S as US } from "@cashu/i18n/core/chrome.strings";
import { C } from "@cashu/i18n/core/common.strings";
import {
  JOB_LABEL,
  JOB_STATUS,
  OUTCOME,
  PRIVACY_SHORT,
  S,
  SECTION,
} from "@cashu/i18n/core/Settings.strings";
import { PRIVACY } from "@cashu/i18n/core/Wizard.strings";
import { DateText } from "@cashu/ui";
import { useEffect, useRef, useState } from "react";
import { useVirtualRows } from "../../presentation/useVirtualRows.js";
import { T } from "./Settings.strings.js";
import type { SettingsScreenState } from "./useSettingsScreen.js";

const sections = [
  "profile",
  "modules",
  "agent",
  "connectors",
  "data",
  "worker",
  "secrets",
  "app",
] as const;
const card = "rounded-lg border border-border bg-surface-raised p-5";
const control =
  "rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent";
const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent";

function SettingsTimestamp({ day, time }: { day: string | null; time: string }) {
  return (
    <>
      {day ? <DateText value={day} /> : T.auditUnknown}
      {time && <> {time}</>}
    </>
  );
}

/** Eight stacked Settings sections, with direct section navigation and no invented host authority. */
export function SettingsView({
  state,
  section,
  strategyPanel,
}: {
  state: SettingsScreenState;
  section?: string;
  strategyPanel?: React.ReactNode;
}) {
  const [active, setActive] = useState<string>(
    section && sections.some((s) => s === section) ? section : "profile",
  );
  useEffect(() => {
    if (section && sections.some((s) => s === section))
      document.getElementById(`settings-${section}`)?.scrollIntoView({ block: "start" });
  }, [section]);
  useEffect(() => {
    const targets = sections
      .map((id) => document.getElementById(`settings-${id}`))
      .filter((node): node is HTMLElement => !!node);
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.slice("settings-".length));
      },
      { rootMargin: "-70px 0px -65% 0px" },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, []);
  return (
    <div className="grid gap-5 p-6 lg:grid-cols-[12rem_minmax(0,1fr)]">
      <nav
        aria-label={S.sectionsNav}
        className="sticky top-4 self-start rounded-lg border border-border bg-surface-raised p-2"
      >
        {sections.map((id) => (
          <button
            key={id}
            type="button"
            aria-current={active === id ? "location" : undefined}
            onClick={() => {
              setActive(id);
              document
                .getElementById(`settings-${id}`)
                ?.scrollIntoView({ behavior: "smooth", block: "start" });
            }}
            className={`block w-full rounded-sm px-3 py-2 text-left hover:bg-surface-sunken ${active === id ? "bg-accent-muted font-semibold" : ""}`}
          >
            {SECTION[id]}
          </button>
        ))}
      </nav>
      <div className="grid min-w-0 gap-5">
        {state.notice && (
          <div role="status" className="rounded-md border border-border bg-surface-raised p-3">
            {state.notice}{" "}
            <button
              type="button"
              onClick={state.onNoticeDismissed}
              aria-label={C.close}
              className={button}
            >
              {C.close}
            </button>
          </div>
        )}
        <Card id="profile" title={SECTION.profile}>
          <ProfileSection state={state} />
        </Card>
        <Card id="modules" title={SECTION.modules}>
          <ModulesSection state={state} />
        </Card>
        <Card id="agent" title={SECTION.agent}>
          <AgentSection state={state} strategyPanel={strategyPanel} />
        </Card>
        <Card id="connectors" title={SECTION.connectors}>
          <ConnectorsSection />
        </Card>
        <Card id="data" title={SECTION.data}>
          <DataSection state={state} />
        </Card>
        <Card id="worker" title={SECTION.worker}>
          <WorkerSection state={state} />
        </Card>
        <Card id="secrets" title={SECTION.secrets}>
          <SecretsSection />
        </Card>
        <Card id="app" title={SECTION.app}>
          <AppSection state={state} />
        </Card>
      </div>
    </div>
  );
}

function Card({
  id,
  title,
  children,
}: {
  id: (typeof sections)[number];
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={`settings-${id}`}
      aria-labelledby={`settings-${id}-title`}
      className={`${card} scroll-mt-4`}
    >
      <h2 id={`settings-${id}-title`} className="mb-4 text-headline font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function ProfileSection({ state }: { state: SettingsScreenState }) {
  if (!state.identity || !state.current) return <p>{T.unavailableStatus}</p>;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void state.profileForm.handleSubmit();
      }}
      className="grid max-w-lg gap-4"
    >
      <state.profileForm.Field name="name">
        {(field) => (
          <label className="grid gap-1">
            {S.name}
            <input
              className={control}
              maxLength={40}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(event) => field.handleChange(event.target.value)}
              aria-describedby="settings-name-hint"
            />
          </label>
        )}
      </state.profileForm.Field>
      <p id="settings-name-hint" className="text-caption text-fg-muted">
        {T.profileNameLimit}
      </p>
      <state.profileForm.Field name="baseCurrency">
        {(field) => (
          <label className="grid gap-1">
            {S.baseCurrency}
            <select
              className={control}
              value={field.state.value}
              onChange={(event) => field.handleChange(event.target.value)}
            >
              {[
                ...new Set([
                  "PLN",
                  "EUR",
                  "USD",
                  "CHF",
                  "GBP",
                  state.current?.baseCurrency ?? "PLN",
                ]),
              ].map((currency) => (
                <option key={currency} value={currency}>
                  {currency}
                </option>
              ))}
            </select>
            <span className="text-caption text-fg-muted">{S.baseCurrencyHint}</span>
          </label>
        )}
      </state.profileForm.Field>
      <p>
        {S.slug}: <code>{state.identity.slug}</code>{" "}
        <span className="text-caption text-fg-muted">{S.slugHint}</span>
      </p>
      <state.profileForm.Subscribe
        selector={(form) => ({
          dirty: form.isDirty,
          submitting: form.isSubmitting,
          errors: form.errors,
        })}
      >
        {({ dirty, submitting, errors }) => (
          <>
            <button
              className={button}
              type="submit"
              disabled={!dirty || submitting || state.profileBusy}
            >
              {C.save}
            </button>
            {errors.length > 0 && <p role="alert">{T.invalidProfile}</p>}
          </>
        )}
      </state.profileForm.Subscribe>
    </form>
  );
}

function ModulesSection({ state }: { state: SettingsScreenState }) {
  return (
    <div className="grid gap-3">
      {state.modules.map((module) => (
        <div key={module.id} className="rounded-md border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={module.enabled}
                disabled={!module.available || state.moduleBusy}
                onChange={() => state.onModuleToggled(module.id)}
                aria-label={S.moduleSwitch(module.name)}
              />{" "}
              <strong>{module.name}</strong>
            </label>
            <span className="text-caption text-fg-muted">
              {module.available
                ? {
                    empty: T.moduleEmpty,
                    partial: T.modulePartial,
                    ready: T.moduleReady,
                  }[module.setupState]
                : S.soon}
            </span>
          </div>
          <p className="mt-2 text-sm text-fg-muted">{module.description}</p>
          {module.dependsOn.length > 0 && (
            <p className="mt-1 text-caption text-fg-muted">{module.dependsOn.join(", ")}</p>
          )}
          {module.enabled && (
            <button
              className={`${button} mt-2`}
              type="button"
              onClick={() => state.onModuleConfigured(module.id)}
            >
              {S.configure}
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

function AgentSection({
  state,
  strategyPanel,
}: {
  state: SettingsScreenState;
  strategyPanel?: React.ReactNode;
}) {
  const selected = state.current?.mcpPrivacy;
  return (
    <div className="grid gap-5">
      <fieldset disabled={state.privacyBusy}>
        <legend className="font-semibold">{PRIVACY.question}</legend>
        <p className="mt-1 text-sm text-fg-muted">{PRIVACY.common}</p>
        <p className="mt-1 text-caption text-fg-muted">{T.privacyOwner}</p>
        <div className="mt-3 grid gap-2">
          {PRIVACY.options.map((option) => (
            <label key={option.value} className="rounded-md border border-border p-3">
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="mcp-privacy"
                  checked={selected === option.value}
                  onChange={() => void state.onMcpPrivacyPicked(option.value)}
                />{" "}
                <strong>{option.title}</strong>
              </span>
              <span className="block pl-6 text-sm">{option.desc}</span>
              <span className="block pl-6 text-caption text-fg-muted">{option.example}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <WorkspaceSection state={state} />
      {strategyPanel}
      <section>
        <h3 className="font-semibold">{T.mcpInstructions}</h3>
        <p className="mt-2 text-sm text-fg-muted">{T.mcpUnavailable}</p>
      </section>
      {state.modules.some((module) => module.id === "investments" && module.enabled) && (
        <section>
          <h3 className="font-semibold">{T.proposals}</h3>
          {state.proposals.length === 0 ? (
            <p className="mt-2 text-sm text-fg-muted">{T.noProposals}</p>
          ) : (
            <ProposalRows state={state} />
          )}
        </section>
      )}
      <AuditSection state={state} />
    </div>
  );
}

function WorkspaceSection({ state }: { state: SettingsScreenState }) {
  const ws = state.workspace;
  return (
    <section className="rounded-md border border-border p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{S.workspace}</h3>
        <button
          className={button}
          type="button"
          disabled={state.workspaceBusy}
          onClick={() => void state.refreshWorkspace()}
        >
          {T.workspaceRefresh}
        </button>
      </div>
      {ws.availability !== "ready" ? (
        <p className="mt-3 text-sm text-fg-muted">{T.workspaceUnbound}</p>
      ) : (
        <div className="mt-3 grid gap-3">
          <p>
            {S.folder}: <code>{ws.path}</code>
            {ws.custom && <> ({S.customFolder})</>}
            {ws.path && (
              <button
                type="button"
                className={`${button} ml-2`}
                onClick={() => void state.onWorkspaceCopied(ws.path ?? "")}
              >
                {S.copy}
              </button>
            )}
          </p>
          <p className="text-caption text-fg-muted">
            {T.workspaceVersion}: {ws.managedVersion ?? "-"} / {ws.currentVersion ?? "-"}
          </p>
          <p className="text-sm text-fg-muted">
            {ws.configured ? (ws.upToDate ? S.managed : S.outdated) : S.createWorkspaceFirst}
          </p>
          {ws.conflict && <p role="alert">{S.folderConflict}</p>}
          {ws.mcpCommandStale && <p role="status">{S.mcpStale}</p>}
          {(ws.outdated?.length ?? 0) > 0 && (
            <div>
              <p>{S.outdated}</p>
              <ul className="list-disc pl-5">
                {ws.outdated?.map((item) => (
                  <li key={`${item.kind}:${item.name}`}>
                    {item.name}: {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {!ws.skillsSource && (
            <p className="text-caption text-fg-muted">{T.workspaceSkillsUnavailable}</p>
          )}
          {(ws.skills?.length ?? 0) > 0 && (
            <div>
              <h4 className="font-medium">{S.skills}</h4>
              <ul className="list-disc pl-5">
                {ws.skills?.map((skill) => {
                  const status =
                    {
                      missing: T.workspaceSkillMissing,
                      ok: T.workspaceSkillOk,
                      outdated: T.workspaceSkillOutdated,
                      modified: T.workspaceSkillModified,
                      conflict: T.workspaceSkillConflict,
                      extra: T.workspaceSkillExtra,
                    }[skill.state] ?? T.auditUnknown;
                  return (
                    <li key={`${skill.module ?? "core"}:${skill.name}`}>
                      {skill.name} · {status} · {skill.version}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {state.editingPath ? (
            <label className="grid gap-1">
              {T.workspacePath}
              <input
                className={control}
                value={state.workspacePath}
                disabled={state.workspaceBusy}
                onChange={(event) => state.setWorkspacePath(event.target.value)}
              />
            </label>
          ) : (
            <button
              type="button"
              className={button}
              disabled={state.workspaceBusy}
              onClick={() => state.setEditingPath(true)}
            >
              {S.changeFolder}
            </button>
          )}
          {state.editingPath && (
            <button
              type="button"
              className={button}
              disabled={state.workspaceBusy}
              onClick={() => state.setEditingPath(false)}
            >
              {T.workspaceCancel}
            </button>
          )}
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={state.force}
              disabled={state.workspaceBusy}
              onChange={(event) => state.setForce(event.target.checked)}
            />
            {S.force}
          </label>
          {ws.exists &&
            state.modules.some((module) => module.id === "investments" && module.enabled) && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={state.routinePermissions}
                  disabled={state.workspaceBusy}
                  onChange={(event) => state.setRoutinePermissions(event.target.checked)}
                />
                {T.workspacePermissions}
              </label>
            )}
          <button
            type="button"
            className={button}
            disabled={
              state.workspaceBusy ||
              !!ws.conflict ||
              (state.editingPath && ws.configured && !state.workspacePath.trim())
            }
            onClick={() => void state.saveWorkspace()}
          >
            {ws.configured ? S.update : S.create}
          </button>
          {ws.claudeCommand && (
            <p>
              {S.fromTerminal}: <code>{ws.claudeCommand}</code>
              <button
                type="button"
                className={`${button} ml-2`}
                onClick={() => void state.onWorkspaceCopied(ws.claudeCommand ?? "")}
              >
                {S.copy}
              </button>
            </p>
          )}
          {ws.routineCommand && (
            <p>
              {S.routine}: <code>{ws.routineCommand}</code>
              <button
                type="button"
                className={`${button} ml-2`}
                onClick={() => void state.onWorkspaceCopied(ws.routineCommand ?? "")}
              >
                {S.copy}
              </button>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function ProposalRows({ state }: { state: SettingsScreenState }) {
  const ref = useRef<HTMLElement>(null);
  const virtual = useVirtualRows({
    count: state.proposals.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 52,
    getItemKey: (index) => state.proposals[index]?.gid ?? String(index),
    overscan: 5,
  });
  return (
    <section ref={ref} aria-label={T.proposals} className="mt-2 max-h-72 overflow-auto">
      <div className="relative" style={{ height: virtual.totalSize }}>
        {virtual.items.map((item) => {
          const row = state.proposals[item.index];
          return row ? (
            <div
              key={item.key}
              ref={virtual.measureElement}
              data-index={item.index}
              className="absolute left-0 top-0 w-full border-b border-border py-2"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <button
                type="button"
                className={button}
                onClick={() => state.onProposalOpened(row.gid)}
                aria-label={T.openProposal}
              >
                {row.summary || T.openProposal}
              </button>
            </div>
          ) : null;
        })}
      </div>
    </section>
  );
}

function AuditSection({ state }: { state: SettingsScreenState }) {
  const ref = useRef<HTMLElement>(null);
  const calls = state.audit.calls;
  const virtual = useVirtualRows({
    count: calls.length,
    getScrollElement: () => ref.current,
    estimateSize: () => 68,
    getItemKey: (index) => String(calls[index]?.id ?? index),
    overscan: 5,
  });
  return (
    <section>
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">{S.callLog}</h3>
        <button type="button" className={button} onClick={state.onAuditRefreshed}>
          {T.workspaceRefresh}
        </button>
      </div>
      <p className="text-caption text-fg-muted">
        {S.last7Days(state.audit.count7d)} · {S.argNamesOnly}
      </p>
      {state.audit.hidden ? (
        <p className="mt-2 text-sm">{T.auditHidden}</p>
      ) : calls.length === 0 ? (
        <p className="mt-2 text-sm">{S.noCalls}</p>
      ) : (
        <section ref={ref} aria-label={S.callLog} className="mt-2 max-h-72 overflow-auto">
          <div className="relative" style={{ height: virtual.totalSize }}>
            {virtual.items.map((item) => {
              const call = calls[item.index];
              return call ? (
                <div
                  key={item.key}
                  ref={virtual.measureElement}
                  data-index={item.index}
                  className="absolute left-0 top-0 w-full border-b border-border py-2 text-sm"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <SettingsTimestamp day={call.calledDay} time={call.calledTime} /> ·{" "}
                  <code>{call.tool}</code> ·{" "}
                  {call.privacy in PRIVACY_SHORT
                    ? PRIVACY_SHORT[call.privacy as keyof typeof PRIVACY_SHORT]
                    : T.auditUnknown}{" "}
                  ·{" "}
                  {call.outcome in OUTCOME
                    ? OUTCOME[call.outcome as keyof typeof OUTCOME][0]
                    : T.auditUnknown}{" "}
                  · {T.auditDuration(call.durationMs)}
                  {call.errorKind && (
                    <>
                      {" "}
                      (<code>{call.errorKind}</code>)
                    </>
                  )}
                  <p className="text-caption text-fg-muted">
                    {call.arguments.map((arg) => `${arg.name}: ${arg.type}`).join(", ")}
                    {call.unknownArgumentCount > 0
                      ? ` ${T.auditUnknownArgs(call.unknownArgumentCount)}`
                      : ""}
                  </p>
                </div>
              ) : null;
            })}
          </div>
        </section>
      )}
    </section>
  );
}

function ConnectorsSection() {
  return (
    <div className="grid gap-3">
      <p>{T.connectorUnavailable}</p>
      <p className="text-caption text-fg-muted">{T.connectorBuilder}</p>
      <p className="text-caption text-fg-muted">{T.connectorDocs}</p>
    </div>
  );
}
function DataSection({ state }: { state: SettingsScreenState }) {
  const info = state.hostInfo;
  return (
    <div className="grid gap-3">
      {info.availability === "ready" && info.dataDir ? (
        <p>
          {S.dataDir}: <code>{info.dataDir}</code>{" "}
          <button className={button} type="button" onClick={() => void state.onDataDirCopied()}>
            {S.copy}
          </button>
        </p>
      ) : (
        <p>{T.dataUnavailable}</p>
      )}
      <p>
        {S.backups}: {S.backupsHintBefore}
        <code>backups</code>
        {S.backupsHintAfter}
      </p>
      <p>{T.migrationUnavailable}</p>
    </div>
  );
}
function WorkerSection({ state }: { state: SettingsScreenState }) {
  const worker = state.worker;
  const serviceLabel = {
    off: T.serviceOff,
    enabled: T.serviceEnabled,
    requires_approval: T.serviceApproval,
    unavailable: T.serviceUnavailable,
    error: T.serviceError,
  }[state.service.state];
  const stateLabel =
    worker?.state === "off"
      ? T.workerOff
      : worker?.state === "safe-mode"
        ? T.workerSafeMode
        : worker?.state === "idle"
          ? T.workerIdle
          : worker?.state === "running"
            ? T.workerRunning
            : worker?.state === "stopped"
              ? T.workerStopped
              : worker?.state === "error"
                ? T.workerError
                : T.workerUnavailable;
  return (
    <div className="grid gap-3">
      <h3 className="font-semibold">{T.serviceTitle}</h3>
      <p role="status">{serviceLabel}</p>
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={state.service.state === "enabled"}
          disabled={
            state.serviceBusy ||
            (state.service.state !== "off" && state.service.state !== "enabled")
          }
          onChange={(event) => void state.onServiceEnabled(event.target.checked)}
        />
        {T.serviceToggle}
      </label>
      {state.service.state === "requires_approval" && (
        <button
          className={button}
          type="button"
          disabled={state.serviceBusy}
          onClick={() => void state.onServiceEnabled(false)}
        >
          {T.serviceCancelApproval}
        </button>
      )}
      {state.service.state === "enabled" && state.serviceNextWakeDay && (
        <p>
          {T.serviceNextWake}:{" "}
          <SettingsTimestamp day={state.serviceNextWakeDay} time={state.serviceNextWakeTime} />
        </p>
      )}
      <p>{stateLabel}</p>
      {worker && worker.state !== "off" && (
        <>
          <p>
            {S.hour}: {worker.schedule}
          </p>
          {worker.nextRunAt && (
            <p>
              {T.workerNextRun}:{" "}
              <SettingsTimestamp day={worker.nextRunDay} time={worker.nextRunTime} />
            </p>
          )}
          {worker.lastTickAt && (
            <p>
              {T.workerLastRun}:{" "}
              <SettingsTimestamp day={worker.lastTickDay} time={worker.lastTickTime} />
            </p>
          )}
          <div className="max-h-72 overflow-auto">
            {worker.jobs.length === 0 ? (
              <p>{T.workerNoRuns}</p>
            ) : (
              <ul className="grid gap-2">
                {worker.jobs.map((job) => {
                  const label =
                    job.job === "connectors.fetch"
                      ? T.workerConnector
                      : job.job in JOB_LABEL
                        ? JOB_LABEL[job.job as keyof typeof JOB_LABEL][0]
                        : job.job;
                  const status =
                    job.status in JOB_STATUS
                      ? JOB_STATUS[job.status as keyof typeof JOB_STATUS][0]
                      : T.auditUnknown;
                  return (
                    <li
                      key={`${job.vault}:${job.job}`}
                      className="rounded-sm border border-border p-2"
                    >
                      {label} · {job.profileName || job.vault.slice(0, 8)} · {status} ·{" "}
                      <SettingsTimestamp day={job.startedDay} time={job.startedTime} />
                      {job.code && (
                        <>
                          {" "}
                          (<code>{job.code}</code>)
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
      <p className="text-caption text-fg-muted">{T.workerSchedulerUnavailable}</p>
    </div>
  );
}
function SecretsSection() {
  return (
    <div className="grid gap-3">
      <p>{T.secretsUnavailable}</p>
      <dl className="grid grid-cols-2 gap-2">
        <dt>{S.anthropicKey}</dt>
        <dd>{T.presenceUnknown}</dd>
        <dt>{S.ebKey}</dt>
        <dd>{T.presenceUnknown}</dd>
        <dt>{S.apiToken}</dt>
        <dd>{T.presenceUnknown}</dd>
      </dl>
      <p className="text-caption text-fg-muted">{T.noSecretEntry}</p>
    </div>
  );
}
function AppSection({ state }: { state: SettingsScreenState }) {
  const updater = state.updater;
  const stage = updater.availability === "ready" ? updater.app : null;
  const stageLabel =
    stage?.stage === "available"
      ? US.newVersion(stage.version ?? "")
      : stage?.stage === "checking"
        ? US.checking
        : stage?.stage === "downloading"
          ? US.downloading(stage.version ?? "")
          : stage?.stage === "installing"
            ? US.installing(stage.version ?? "")
            : stage?.stage === "up_to_date"
              ? US.upToDate
              : stage?.stage === "error"
                ? US.updateFailed
                : T.updatesAvailable;
  return (
    <div className="grid gap-4">
      <label className="grid gap-1">
        {S.theme}
        <select
          className={control}
          value={state.preferences.theme ?? "system"}
          onChange={(event) =>
            void state.onThemePicked(event.target.value as "system" | "light" | "dark")
          }
        >
          <option value="system">{S.themeSystem}</option>
          <option value="light">{S.themeLight}</option>
          <option value="dark">{S.themeDark}</option>
        </select>
      </label>
      <label className="grid gap-1">
        {S.language}
        <select
          className={control}
          value={state.preferences.languagePin ?? "system"}
          onChange={(event) =>
            void state.onLanguagePicked(event.target.value as "system" | "pl" | "en")
          }
        >
          <option value="system">{S.languageSystem}</option>
          <option value="pl">{LANG_NAME.pl}</option>
          <option value="en">{LANG_NAME.en}</option>
        </select>
      </label>
      <p>
        {S.version}:{" "}
        {state.updater.availability === "ready" ? state.updater.current : T.versionUnknown}
      </p>
      <p>
        {S.updates}: {state.updater.availability === "ready" ? stageLabel : T.updatesUnavailable}
      </p>
      {state.updater.availability === "ready" && (
        <button
          className={button}
          type="button"
          disabled={state.updaterBusy}
          onClick={() => void state.onCheckUpdates()}
        >
          {T.checkUpdates}
        </button>
      )}
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          disabled={state.updater.availability !== "ready" || state.updaterBusy}
          checked={state.preferences.updatesAuto ?? false}
          onChange={(event) => void state.onUpdatesAutoPicked(event.target.checked)}
        />
        {S.updatesDaily}
      </label>
    </div>
  );
}
