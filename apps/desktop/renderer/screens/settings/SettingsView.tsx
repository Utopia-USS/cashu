// Ustawienia (ab24ab6 core/Settings.tsx + ConnectorsSection.tsx): sticky section nav with scroll-spy and
// stacked cards. Saves report through the toast stack, as in the Python app. Native-only parts (devices,
// connector installs and bindings, the OS service, notification permission, agent proposals) sit in the
// same card / row / key-value idiom.
import { LANG_NAME } from "@cashu/i18n";
import { S as CS } from "@cashu/i18n/core/ConnectorsSection.strings";
import { C } from "@cashu/i18n/core/common.strings";
import { KIND, MODULE, STATUS } from "@cashu/i18n/core/connectors.strings";
import {
  JOB_LABEL,
  JOB_STATUS,
  OUTCOME,
  PRIVACY_SHORT,
  S,
  SECTION,
} from "@cashu/i18n/core/Settings.strings";
import { S as SP } from "@cashu/i18n/core/SetupPage.strings";
import { PRIVACY } from "@cashu/i18n/core/Wizard.strings";
import { WS } from "@cashu/i18n/core/workspace.strings";
import {
  Button,
  CodeLine,
  dataTableCls,
  dataTdCls,
  dataThCls,
  KeyValues,
  Notice,
  RadioList,
  SectionCard,
  Seg,
  SettingRow,
  Skeleton,
  Switch,
  scrollCls,
  Tag,
  ToastProvider,
  useToast,
  useUiEnv,
} from "@cashu/ui";
import { type ReactNode, useEffect, useState } from "react";
import { T } from "./Settings.strings.js";
import { needsForce, outdatedLabel, tagTone, workspaceSummary } from "./settingsModel.js";
import type { SettingsScreenState } from "./useSettingsScreen.js";

const sections = [
  "profile",
  "modules",
  "agent",
  "connectors",
  "data",
  "worker",
  "secrets",
  "devices",
  "app",
] as const;
type SectionId = (typeof sections)[number];

// Old global classes: `.controls` (+ `.spacer`), `.hint`, `.foot`, `.muted`, bare `input` / `select`, `code`.
const controls = "flex flex-wrap items-center gap-2";
/** Old `.hint`: the strategy-hint chip rule (index.css P2) overrides the plain helper text, so it is a chip. */
const hint =
  "inline-flex max-w-full items-center whitespace-nowrap rounded-full border border-border px-1.5 py-px align-middle text-2xs leading-normal text-fg-muted tabular-nums";
const foot = "mt-2.5 text-xs-plus text-fg-muted";
const inputCls =
  "rounded-control border border-border bg-chip px-2.25 py-1.25 text-sm text-fg focus:border-accent focus:outline-none focus-visible:outline-none";
const selectCls =
  "rounded-control border border-border bg-chip px-2 py-1 text-xs text-fg focus:border-accent focus:outline-none focus-visible:outline-none";
/** Old global `code`: 0.92em of the surrounding text, monospace, no ligatures. */
const code = "font-mono text-code-ui [font-variant-ligatures:none]";

const sectionTitle = (id: SectionId) => (id === "devices" ? T.devicesTitle : SECTION[id]);

/** Old `timeFmt` (day.month, hour:minute) of a server time; "-" when there is none. */
function useWhen() {
  const { locale } = useUiEnv();
  const format = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return (iso: string | null | undefined) => {
    const time = iso ? new Date(iso) : null;
    return time && !Number.isNaN(time.getTime()) ? format.format(time) : "-";
  };
}

/** The Settings page: section nav + one card per section, in the old order (devices before the app). */
export function SettingsView(props: {
  state: SettingsScreenState;
  section?: string;
  strategyPanel?: ReactNode;
  devicesPanel?: ReactNode;
  bankingPanel?: ReactNode;
  classificationPanel?: ReactNode;
}) {
  return (
    <ToastProvider>
      <SettingsPage {...props} />
    </ToastProvider>
  );
}

function SettingsPage({
  state,
  section,
  strategyPanel,
  devicesPanel,
  bankingPanel,
  classificationPanel,
}: {
  state: SettingsScreenState;
  section?: string;
  strategyPanel?: ReactNode;
  devicesPanel?: ReactNode;
  bankingPanel?: ReactNode;
  classificationPanel?: ReactNode;
}) {
  const [active, setActive] = useState<string>(
    section && sections.some((s) => s === section) ? section : "profile",
  );
  // Jump to the requested section (e.g. from the setup page's privacy notice).
  useEffect(() => {
    if (section) document.getElementById(`set-${section}`)?.scrollIntoView({ block: "start" });
  }, [section]);
  // Scroll-spy: the nav follows the card nearest the top of the viewport.
  useEffect(() => {
    const targets = sections
      .map((id) => document.getElementById(`set-${id}`))
      .filter((node): node is HTMLElement => !!node);
    const observer = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (top) setActive(top.target.id.slice(4));
      },
      { rootMargin: "-70px 0px -65% 0px" },
    );
    for (const target of targets) observer.observe(target);
    return () => observer.disconnect();
  }, []);
  const investments = state.modules.some((m) => m.id === "investments" && m.enabled);
  return (
    <div className="mx-auto max-w-280 px-5 pb-17.5 text-base leading-normal text-fg">
      <NoticeToast notice={state.notice} onShown={state.onNoticeDismissed} />
      <div className="grid grid-cols-[--spacing(50)_minmax(0,1fr)] items-start gap-5 max-settings:grid-cols-[minmax(0,1fr)]">
        <nav
          aria-label={S.sectionsNav}
          className="sticky top-16 grid min-w-0 gap-0.5 max-settings:static max-settings:flex max-settings:flex-wrap max-settings:gap-1"
        >
          {sections.map((id) => (
            <button
              key={id}
              type="button"
              aria-current={active === id ? "true" : undefined}
              onClick={() => {
                setActive(id);
                document
                  .getElementById(`set-${id}`)
                  ?.scrollIntoView({ behavior: "smooth", block: "start" });
              }}
              className={`block cursor-pointer rounded-control border px-3 py-1.75 text-left text-md font-demi hover:text-fg ${active === id ? "border-border bg-surface-raised text-fg" : "border-transparent bg-transparent text-fg-muted"}`}
            >
              {sectionTitle(id)}
            </button>
          ))}
        </nav>
        <div className="min-w-0">
          <Card id="profile">
            <ProfileSection state={state} />
          </Card>
          <Card id="modules">
            <ModulesSection state={state} />
          </Card>
          <Card id="agent">
            <AgentSection state={state} investments={investments} strategyPanel={strategyPanel} />
          </Card>
          <ConnectorsSection state={state} bankingPanel={bankingPanel} />
          <Card id="data">
            <DataSection state={state} />
          </Card>
          <Card id="worker">
            <WorkerSection state={state} />
          </Card>
          <Card id="secrets">
            <SecretsSection />
            {classificationPanel}
          </Card>
          <Card id="devices">
            {devicesPanel ?? <div className="text-sm text-fg-muted">{T.unavailable}</div>}
          </Card>
          <Card id="app">
            <AppSection state={state} />
          </Card>
        </div>
      </div>
    </div>
  );
}

/** The hook's one-line notice goes out as a toast (the old page toasted every save). */
function NoticeToast({ notice, onShown }: { notice: string | null; onShown: () => void }) {
  const toast = useToast();
  useEffect(() => {
    if (!notice) return;
    toast(notice);
    onShown();
  }, [notice, toast, onShown]);
  return null;
}

function Card({ id, children }: { id: SectionId; children: ReactNode }) {
  return (
    <SectionCard id={`set-${id}`} title={sectionTitle(id)} className="scroll-mt-16">
      {children}
    </SectionCard>
  );
}

const currencies = ["PLN", "EUR", "USD", "CHF", "GBP"];

function ProfileSection({ state }: { state: SettingsScreenState }) {
  if (!state.identity || !state.current)
    return <div className="text-sm text-fg-muted">{T.unavailableStatus}</div>;
  const slug = state.identity.slug;
  const form = state.profileForm;
  return (
    <>
      <KeyValues
        rows={[
          {
            key: "name",
            label: S.name,
            htmlFor: "set-name",
            value: (
              <form.Field name="name">
                {(field) => (
                  <input
                    id="set-name"
                    className={`${inputCls} w-55`}
                    maxLength={40}
                    value={field.state.value}
                    onBlur={field.handleBlur}
                    onChange={(event) => field.handleChange(event.target.value)}
                  />
                )}
              </form.Field>
            ),
          },
          {
            key: "currency",
            label: S.baseCurrency,
            htmlFor: "set-cur",
            value: (
              <>
                <form.Field name="baseCurrency">
                  {(field) => (
                    <select
                      id="set-cur"
                      className={selectCls}
                      value={field.state.value}
                      onChange={(event) => field.handleChange(event.target.value)}
                    >
                      {[...new Set([...currencies, state.current?.baseCurrency ?? "PLN"])].map(
                        (currency) => (
                          <option key={currency}>{currency}</option>
                        ),
                      )}
                    </select>
                  )}
                </form.Field>
                <span className={hint}>{S.baseCurrencyHint}</span>
              </>
            ),
          },
          {
            key: "slug",
            label: S.slug,
            value: (
              <>
                <code className={code}>{slug}</code>
                <span className={hint}>
                  {S.slugHint} (<code className={code}>--profile {slug}</code>)
                </span>
              </>
            ),
          },
        ]}
      />
      <form.Subscribe
        selector={(f) => ({ dirty: f.isDirty, submitting: f.isSubmitting, errors: f.errors })}
      >
        {({ dirty, submitting, errors }) => (
          <>
            {errors.length > 0 && (
              <Notice tone="negative" role="alert" className="mt-3.5">
                {T.invalidProfile}
              </Notice>
            )}
            <div className={`${controls} mt-4`}>
              <Button
                variant="primary"
                disabled={!dirty || submitting || state.profileBusy}
                onPress={() => void form.handleSubmit()}
              >
                {C.save}
              </Button>
            </div>
          </>
        )}
      </form.Subscribe>
    </>
  );
}

function ModulesSection({ state }: { state: SettingsScreenState }) {
  return (
    <>
      {state.modules.map((m) => {
        const pending = m.enabled && m.setupState !== "ready";
        return (
          <SettingRow
            key={m.id}
            control={
              <Switch
                on={m.enabled}
                disabled={!m.available || state.moduleBusy}
                label={S.moduleSwitch(m.name)}
                title={!m.available ? S.soonTitle : undefined}
                onChange={() => state.onModuleToggled(m.id)}
              />
            }
            title={
              <>
                {m.name}
                {!m.available ? (
                  <Tag>{S.soon}</Tag>
                ) : m.enabled ? (
                  m.setupState === "ready" ? (
                    <Tag tone="positive">{SP.ready}</Tag>
                  ) : (
                    <Tag tone="warning">{SP.notConfigured}</Tag>
                  )
                ) : null}
              </>
            }
            detail={
              !m.enabled && m.available && m.setupState !== "empty"
                ? S.offDataKept(m.description)
                : m.description
            }
            action={
              pending ? (
                <Button variant="link" size="lg" onPress={() => state.onModuleConfigured(m.id)}>
                  {S.configure}
                </Button>
              ) : null
            }
          />
        );
      })}
    </>
  );
}

function AgentSection({
  state,
  investments,
  strategyPanel,
}: {
  state: SettingsScreenState;
  investments: boolean;
  strategyPanel?: ReactNode;
}) {
  return (
    <>
      <RadioList
        name="mcp-privacy"
        label={PRIVACY.question}
        value={PRIVACY.options.find((o) => o.value === state.current?.mcpPrivacy)?.value ?? null}
        disabled={state.privacyBusy}
        onChange={(value) => void state.onMcpPrivacyPicked(value)}
        options={PRIVACY.options.map((option) => ({
          value: option.value,
          title: option.title,
          desc: option.desc,
          tooltip: option.example,
        }))}
      />
      <div className="mt-1 text-xs-plus text-fg-muted">{PRIVACY.common}</div>
      <Notice tone="info">{WS.proposalNote}</Notice>
      <WorkspacePanel state={state} investments={investments} />
      <KeyValues
        className="mt-3.5"
        rows={[
          {
            key: "mcp",
            label: T.mcpInstructions,
            value: <span className="text-sm text-fg-muted">{T.mcpUnavailable}</span>,
          },
        ]}
      />
      {strategyPanel}
      {investments && <ProposalsPanel state={state} />}
      <AuditLog state={state} />
    </>
  );
}

function WorkspacePanel({
  state,
  investments,
}: {
  state: SettingsScreenState;
  investments: boolean;
}) {
  const ws = state.workspace;
  const busy = state.workspaceBusy;
  const ready = ws.availability === "ready";
  const summary = workspaceSummary(ws);
  const copy = (text: string) => () => void state.onWorkspaceCopied(text);
  return (
    <div className="mt-3.5">
      <div className={`${controls} mb-1.5`}>
        <strong className="text-md" title={S.workspaceTitle}>
          {S.workspace}
        </strong>
        {ready && <Tag tone={summary.tone}>{summary.text}</Tag>}
        <span className="flex-1" />
        {ready && ws.exists && ws.mcpCommandStale && (
          <Tag tone="warning" title={S.mcpStaleTitle}>
            {S.mcpStale}
          </Tag>
        )}
        {ready && ws.exists && (
          <Button
            title={S.updateTitle}
            disabled={busy}
            onPress={() => void state.saveWorkspace({ path: null })}
          >
            {busy ? S.updating : S.update}
          </Button>
        )}
        {ready && !ws.exists && (
          <Button variant="primary" disabled={busy} onPress={() => void state.saveWorkspace()}>
            {busy ? S.creating : S.create}
          </Button>
        )}
        {!ready && !busy && (
          <Button onPress={() => void state.refreshWorkspace()}>{T.workspaceRefresh}</Button>
        )}
      </div>
      {!ready && (
        <div className="text-sm text-fg-muted">{busy ? S.checking : T.workspaceUnbound}</div>
      )}
      {ready && (
        <KeyValues
          rows={[
            {
              key: "folder",
              label: S.folder,
              value: (
                <>
                  <code className={code}>{ws.path}</code>
                  {ws.custom && <Tag>{S.customFolder}</Tag>}
                  <Button
                    variant="link"
                    size="lg"
                    disabled={busy}
                    onPress={() => state.setEditingPath(!state.editingPath)}
                  >
                    {state.editingPath ? C.cancel : S.changeFolder}
                  </Button>
                </>
              ),
            },
            ...(state.editingPath
              ? [
                  {
                    key: "new-folder",
                    label: S.newFolder,
                    htmlFor: "set-ws-path",
                    value: (
                      <>
                        <input
                          id="set-ws-path"
                          className={`${inputCls} min-w-55 flex-1`}
                          value={state.workspacePath}
                          autoComplete="off"
                          spellCheck={false}
                          disabled={busy}
                          onChange={(event) => state.setWorkspacePath(event.target.value)}
                        />
                        {ws.exists && (
                          <Button
                            disabled={busy || !state.workspacePath.trim()}
                            onPress={() => void state.saveWorkspace({ path: state.workspacePath })}
                          >
                            {S.move}
                          </Button>
                        )}
                      </>
                    ),
                  },
                ]
              : []),
            ...(ws.exists && ws.claudeCommand
              ? [
                  {
                    key: "claude",
                    label: S.openInClaude,
                    block: true,
                    value: <CodeLine command={ws.claudeCommand} onCopy={copy(ws.claudeCommand)} />,
                  },
                ]
              : []),
            ...(ws.exists
              ? [
                  {
                    key: "managed",
                    label: S.managed,
                    value: (
                      <span className="text-sm">
                        cashU {ws.managedVersion ?? "-"} · {S.skills}:{" "}
                        {(ws.skills ?? [])
                          .filter((skill) => skill.state !== "extra")
                          .map((skill) => `/${skill.name}`)
                          .join(", ") || S.none}
                      </span>
                    ),
                  },
                ]
              : []),
          ]}
        />
      )}
      {ready && !ws.skillsSource && (
        <div className={`${hint} mt-1.5`}>{T.workspaceSkillsUnavailable}</div>
      )}
      {ready && ws.conflict && (
        <Notice tone="negative" role="alert" className="mt-2.5 mb-0">
          {S.folderConflict}
        </Notice>
      )}
      {ready && ws.exists && (ws.outdated?.length ?? 0) > 0 && (
        <Notice
          tone="warning"
          role="alert"
          className="mt-2.5 mb-0"
          action={
            needsForce(ws) ? (
              <Button
                title={S.forceTitle}
                disabled={busy}
                onPress={() => void state.saveWorkspace({ path: null, force: true })}
              >
                {S.force}
              </Button>
            ) : undefined
          }
        >
          {S.outdated}
          <ul className="mt-1 mb-0 list-disc pl-4.5">
            {ws.outdated?.map((item) => (
              <li key={`${item.kind}:${item.name}`}>{outdatedLabel(item)}</li>
            ))}
          </ul>
        </Notice>
      )}
      {investments && ready && (
        <div className="mt-3">
          <div className={`${controls} mb-1 text-sm`}>
            <Switch
              on={ws.routinePermissions ?? false}
              label={WS.routinePermissionsLabel}
              disabled={busy || !ws.exists}
              title={!ws.exists ? S.createWorkspaceFirst : undefined}
              onChange={(on) => void state.saveWorkspace({ path: null, routinePermissions: on })}
            />
            <span>{WS.routinePermissionsLabel}</span>
          </div>
          <div className="text-xs-plus text-fg-muted">{WS.routinePermissionsHint}</div>
          {ws.exists && (
            <KeyValues
              className="mt-2"
              rows={[
                {
                  key: "routine",
                  label: S.routine,
                  title: S.routineTitle,
                  value: (
                    <>
                      <code className={code}>/market-research rutyna</code>
                      <span className={hint}>{S.routineHint}</span>
                    </>
                  ),
                },
                ...(ws.routineCommand
                  ? [
                      {
                        key: "terminal",
                        label: S.fromTerminal,
                        block: true,
                        value: (
                          <CodeLine command={ws.routineCommand} onCopy={copy(ws.routineCommand)} />
                        ),
                      },
                    ]
                  : []),
              ]}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Native-only: the profile's pending agent proposals, each opening the proposal drawer. */
function ProposalsPanel({ state }: { state: SettingsScreenState }) {
  return (
    <>
      <div className={`${controls} mt-3.5 mb-1.5`}>
        <strong className="text-md">{T.proposals}</strong>
        {state.proposals.length > 0 && <Tag>{state.proposals.length}</Tag>}
      </div>
      <section aria-label={T.proposals} className={scrollCls(true)}>
        {state.proposals.length === 0 ? (
          <div className="text-sm text-fg-muted">{T.noProposals}</div>
        ) : (
          state.proposals.map((row) => (
            <SettingRow
              key={row.gid}
              title={
                <Button
                  variant="link"
                  size="lg"
                  label={T.openProposal}
                  onPress={() => state.onProposalOpened(row.gid)}
                >
                  {row.summary || T.openProposal}
                </Button>
              }
            />
          ))
        )}
      </section>
    </>
  );
}

function AuditLog({ state }: { state: SettingsScreenState }) {
  const when = useWhen();
  const calls = state.audit.calls;
  return (
    <>
      <div className={`${controls} mt-3.5 mb-1.5`}>
        <strong className="text-md">{S.callLog}</strong>
        <Tag>{S.last7Days(state.audit.count7d)}</Tag>
        <span className="flex-1" />
        <Button onPress={state.onAuditRefreshed}>{C.refresh}</Button>
      </div>
      <div className={scrollCls(true)}>
        <table className={dataTableCls}>
          <thead>
            <tr>
              <th className={dataThCls()}>{S.colTime}</th>
              <th className={dataThCls()}>{S.colTool}</th>
              <th className={dataThCls()}>{S.colArgs}</th>
              <th className={dataThCls()}>{S.colLevel}</th>
              <th className={dataThCls()}>{S.colResult}</th>
            </tr>
          </thead>
          <tbody>
            {!state.audit.hidden &&
              calls.map((call) => {
                const [label, tone] =
                  call.outcome in OUTCOME
                    ? OUTCOME[call.outcome as keyof typeof OUTCOME]
                    : [call.outcome || "-", undefined];
                const args = [
                  call.arguments.map((arg) => arg.name).join(", "),
                  call.unknownArgumentCount > 0
                    ? T.auditUnknownArgs(call.unknownArgumentCount)
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr key={call.id}>
                    <td className={`${dataTdCls()} whitespace-nowrap`}>{when(call.calledAt)}</td>
                    <td className={dataTdCls()}>
                      <code className={code}>{call.tool}</code>
                    </td>
                    <td className={`${dataTdCls()} text-xs-plus text-fg-muted`}>{args || "-"}</td>
                    <td className={dataTdCls()}>
                      {call.privacy in PRIVACY_SHORT
                        ? PRIVACY_SHORT[call.privacy as keyof typeof PRIVACY_SHORT]
                        : call.privacy || "-"}
                    </td>
                    <td className={dataTdCls()}>
                      <Tag tone={tagTone(tone)}>{label}</Tag>
                      {call.errorKind ? <span className={hint}> {call.errorKind}</span> : null}
                      <span className={hint}> · {T.auditDuration(call.durationMs)}</span>
                    </td>
                  </tr>
                );
              })}
            {(state.audit.hidden || calls.length === 0) && (
              <tr>
                <td colSpan={5} className={`${dataTdCls()} text-fg-muted`}>
                  {state.audit.hidden ? T.auditHidden : S.noCalls}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className={foot}>{S.argNamesOnly}</div>
    </>
  );
}

type Snapshot = NonNullable<SettingsScreenState["connectorSnapshot"]>;

function ConnectorsSection({
  state,
  bankingPanel,
}: {
  state: SettingsScreenState;
  bankingPanel?: ReactNode;
}) {
  const snapshot = state.connectorSnapshot;
  const busy = state.connectorBusy;
  const connectors = snapshot?.connectors ?? [];
  const waiting = connectors.filter(
    (c) => c.approval === "pending" || c.approval === "changed",
  ).length;
  const actions = (
    <>
      <Button disabled={busy} onPress={() => void state.installConnector()}>
        {T.connectorInstall}
      </Button>
      <Button disabled={busy} onPress={() => void state.refreshConnectors()}>
        {C.refresh}
      </Button>
    </>
  );
  return (
    <SectionCard id="set-connectors" title={CS.title} className="scroll-mt-16">
      {snapshot && (
        <div className={`${controls} mb-1.5`}>
          {connectors.length > 0 && <Tag>{CS.count(connectors.length)}</Tag>}
          {waiting > 0 && (
            <Tag tone="warning" solid>
              {CS.toApprove(waiting)}
            </Tag>
          )}
          <span className="flex-1" />
          {actions}
        </div>
      )}
      {!snapshot &&
        (busy ? (
          [0, 1, 2].map((k) => <Skeleton key={k} height={40} className="my-1.5" />)
        ) : (
          <Notice tone="negative" role="alert" action={actions}>
            {T.connectorUnavailable}
          </Notice>
        ))}
      {snapshot && connectors.length === 0 && (
        <div className="py-2 text-md text-fg-muted">
          <div className="font-strong text-fg">{CS.emptyTitle}</div>
          <div className="mt-1 text-sm">
            {CS.emptyBefore}
            <code className={code}>/import-builder</code>
            {CS.emptyAfter}
          </div>
        </div>
      )}
      {connectors.map((connector) => (
        <ConnectorRow
          key={`${state.connectorVault}:${connector.id}`}
          connector={connector}
          state={state}
        />
      ))}
      {snapshot?.bindings.map((binding) => (
        <BindingRow
          key={`${state.connectorVault}:${binding.gid}`}
          binding={binding}
          state={state}
        />
      ))}
      <div className={foot}>{CS.foot}</div>
      {bankingPanel}
    </SectionCard>
  );
}

function ConnectorRow({
  connector,
  state,
}: {
  connector: Snapshot["connectors"][number];
  state: SettingsScreenState;
}) {
  const [account, setAccount] = useState("");
  const [params, setParams] = useState<Record<string, string | boolean>>({});
  const [auto, setAuto] = useState(false);
  const busy = state.connectorBusy;
  const [status, tone, solid] = STATUS[connector.approval];
  const fieldId = (spec: string) => `connector-${connector.id}-${spec}`;
  return (
    <SettingRow
      title={
        <>
          {connector.name}
          <Tag>{connector.module in MODULE ? MODULE[connector.module] : connector.module}</Tag>
          <Tag>{connector.kind in KIND ? KIND[connector.kind] : connector.kind}</Tag>
          <Tag tone={tagTone(tone)} solid={solid}>
            {status}
          </Tag>
        </>
      }
      detail={
        <>
          <span className="block wrap-anywhere">
            {T.connectorDigest}: <code className={code}>{connector.contentSha256}</code>
          </span>
          <span className="block wrap-anywhere">
            {T.connectorInterpreter}:{" "}
            <code className={code}>{connector.interpreter ?? T.unavailable}</code>
          </span>
        </>
      }
      action={
        <div className={controls}>
          {connector.approval !== "approved" && connector.interpreter && (
            <Button
              variant="primary"
              disabled={busy}
              onPress={() =>
                connector.interpreter &&
                void state.onConnectorAction({
                  op: "approve",
                  id: connector.id,
                  digest: connector.contentSha256,
                  interpreter: connector.interpreter,
                })
              }
            >
              {T.connectorApprove}
            </Button>
          )}
          {connector.approval === "approved" && (
            <Button
              disabled={busy}
              onPress={() => void state.onConnectorAction({ op: "disable", id: connector.id })}
            >
              {T.connectorDisable}
            </Button>
          )}
          <Button
            disabled={busy}
            onPress={() => {
              if (window.confirm(T.connectorRemoveAllConfirm))
                void state.onConnectorAction({ op: "remove", id: connector.id, allVaults: true });
            }}
          >
            {T.connectorRemoveAll}
          </Button>
        </div>
      }
    >
      {connector.approval === "approved" && connector.kind === "fetch" && (
        <div className={`${controls} mt-2 text-sm`}>
          <select
            aria-label={T.connectorAccount}
            className={selectCls}
            value={account}
            onChange={(event) => setAccount(event.target.value)}
          >
            <option value="">{T.connectorAccount}</option>
            {state.connectorAccounts(connector).map((item) => (
              <option key={item.gid} value={item.gid}>
                {item.name}
              </option>
            ))}
          </select>
          {connector.params.map((spec) =>
            spec.type === "boolean" ? (
              <label key={spec.id} className="flex items-center gap-1.5" htmlFor={fieldId(spec.id)}>
                <input
                  id={fieldId(spec.id)}
                  type="checkbox"
                  className="accent-accent"
                  checked={params[spec.id] === true}
                  onChange={(event) =>
                    setParams((value) => ({ ...value, [spec.id]: event.target.checked }))
                  }
                />
                {spec.label || T.connectorParam}
              </label>
            ) : (
              <label key={spec.id} className="flex items-center gap-1.5" htmlFor={fieldId(spec.id)}>
                {spec.label || T.connectorParam}
                <input
                  id={fieldId(spec.id)}
                  className={inputCls}
                  type={spec.type === "date" ? "date" : spec.type === "number" ? "number" : "text"}
                  value={typeof params[spec.id] === "string" ? (params[spec.id] as string) : ""}
                  onChange={(event) =>
                    setParams((value) => ({ ...value, [spec.id]: event.target.value }))
                  }
                />
              </label>
            ),
          )}
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              className="accent-accent"
              checked={auto}
              onChange={(event) => setAuto(event.target.checked)}
            />
            {T.connectorAuto}
          </label>
          <Button
            disabled={busy || !account}
            onPress={() => void state.bindConnector(connector, account, params, auto)}
          >
            {T.connectorBind}
          </Button>
        </div>
      )}
    </SettingRow>
  );
}

function BindingRow({
  binding,
  state,
}: {
  binding: Snapshot["bindings"][number];
  state: SettingsScreenState;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const busy = state.connectorBusy;
  const connector = state.connectorSnapshot?.connectors.find(
    (item) => item.id === binding.connector_id,
  );
  const account = state.connectorSnapshot?.accounts.find((item) => item.gid === binding.account);
  return (
    <SettingRow
      title={`${connector?.name ?? binding.connector_id} · ${account?.name ?? binding.account}`}
      action={
        <div className={controls}>
          <Button
            variant="primary"
            disabled={busy || connector?.approval !== "approved"}
            onPress={() => void state.onConnectorAction({ op: "run", binding: binding.gid })}
          >
            {T.connectorRun}
          </Button>
          <Button
            disabled={busy}
            onPress={() => void state.onConnectorAction({ op: "unbind", binding: binding.gid })}
          >
            {T.connectorUnbind}
          </Button>
        </div>
      }
    >
      {connector?.secrets.map((spec) => (
        <div key={spec.id} className={`${controls} mt-2 text-sm`}>
          <label className="flex items-center gap-1.5">
            {spec.label || T.connectorSecret}
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              value={values[spec.id] ?? ""}
              onChange={(event) =>
                setValues((previous) => ({ ...previous, [spec.id]: event.target.value }))
              }
            />
          </label>
          <Button
            disabled={busy || !values[spec.id]}
            onPress={() => {
              const value = values[spec.id];
              if (!value) return;
              void state.onConnectorAction({
                op: "setSecret",
                binding: binding.gid,
                secret: spec.id,
                value,
              });
              setValues((previous) => ({ ...previous, [spec.id]: "" }));
            }}
          >
            {T.connectorSetSecret}
          </Button>
          <Button
            disabled={busy}
            onPress={() =>
              void state.onConnectorAction({
                op: "clearSecret",
                binding: binding.gid,
                secret: spec.id,
              })
            }
          >
            {T.connectorClearSecret}
          </Button>
        </div>
      ))}
    </SettingRow>
  );
}

function DataSection({ state }: { state: SettingsScreenState }) {
  const info = state.hostInfo;
  const dir = info.availability === "ready" ? info.dataDir : null;
  return (
    <KeyValues
      rows={[
        {
          key: "dir",
          label: S.dataDir,
          value: (
            <>
              <code className={`${code} wrap-anywhere`}>{dir ?? "-"}</code>
              {dir && <Button onPress={() => void state.onDataDirCopied()}>{S.copy}</Button>}
            </>
          ),
        },
        {
          key: "backups",
          label: S.backups,
          value: (
            <span className="text-sm text-fg-muted">
              {S.backupsHintBefore}
              <code className={code}>backups</code>
              {S.backupsHintAfter}
            </span>
          ),
        },
      ]}
    />
  );
}

const serviceLabels = {
  off: T.serviceOff,
  enabled: T.serviceEnabled,
  requires_approval: T.serviceApproval,
  unavailable: T.serviceUnavailable,
  error: T.serviceError,
};

function WorkerSection({ state }: { state: SettingsScreenState }) {
  const when = useWhen();
  const worker = state.worker;
  const service = state.service.state;
  const serviceLabel = serviceLabels[service];
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
  const workerTone =
    worker?.state === "running" || worker?.state === "idle"
      ? "positive"
      : worker?.state === "error"
        ? "negative"
        : "neutral";
  const schedule = worker?.schedule ? S.dailyAt(worker.schedule) : S.daily;
  const on = worker && worker.state !== "off";
  return (
    <>
      <SettingRow
        className="pt-0"
        control={
          <Switch
            on={service === "enabled"}
            disabled={state.serviceBusy || (service !== "off" && service !== "enabled")}
            label={T.serviceToggle}
            title={service === "unavailable" || service === "error" ? serviceLabel : undefined}
            onChange={(enabled) => void state.onServiceEnabled(enabled)}
          />
        }
        title={
          <>
            {T.serviceToggle}{" "}
            <Tag
              tone={
                service === "enabled"
                  ? "positive"
                  : service === "requires_approval"
                    ? "warning"
                    : service === "error"
                      ? "negative"
                      : "neutral"
              }
            >
              {serviceLabel}
            </Tag>
          </>
        }
        detail={
          <>
            {T.serviceTitle}
            {service === "enabled" && state.service.nextWake
              ? ` · ${T.serviceNextWake} ${when(state.service.nextWake)}`
              : ""}
          </>
        }
        action={
          service === "requires_approval" ? (
            <Button disabled={state.serviceBusy} onPress={() => void state.onServiceEnabled(false)}>
              {T.serviceCancelApproval}
            </Button>
          ) : null
        }
      />
      <SettingRow
        title={
          <>
            {on ? S.everyDayAt(worker.schedule) : SECTION.worker}{" "}
            <Tag tone={workerTone}>{stateLabel}</Tag>
          </>
        }
        detail={
          on ? (
            <>
              {schedule}
              {worker.nextRunAt ? S.nextRun(when(worker.nextRunAt)) : ""}
              {worker.lastTickAt ? S.lastRun(when(worker.lastTickAt)) : S.neverRun}
            </>
          ) : null
        }
      />
      {on && (
        <div className={scrollCls()}>
          <table className={`${dataTableCls} mt-1.5`}>
            <thead>
              <tr>
                <th className={dataThCls()}>{S.colJob}</th>
                <th className={dataThCls()}>{S.colModule}</th>
                <th className={dataThCls()}>{S.colSchedule}</th>
                <th className={dataThCls()}>{S.colLast}</th>
                <th className={dataThCls()}>{S.colStatus}</th>
              </tr>
            </thead>
            <tbody>
              {worker.jobs.map((job) => {
                const [label, module] =
                  job.job === "connectors.fetch"
                    ? [T.workerConnector, "-"]
                    : job.job in JOB_LABEL
                      ? JOB_LABEL[job.job as keyof typeof JOB_LABEL]
                      : [job.job, "-"];
                const [status, tone] =
                  job.status in JOB_STATUS
                    ? JOB_STATUS[job.status as keyof typeof JOB_STATUS]
                    : [null, undefined];
                const sched =
                  job.job === "digest"
                    ? S.digestDay
                    : job.job === "budget.sync"
                      ? S.bankLimit(schedule)
                      : schedule;
                const owner =
                  job.vault !== state.vault ? `${job.profileName || job.vault.slice(0, 8)}: ` : "";
                return (
                  <tr key={`${job.vault}:${job.job}`} className={status ? "" : "text-fg-muted"}>
                    <td className={dataTdCls()}>{label}</td>
                    <td className={dataTdCls()}>{module}</td>
                    <td className={dataTdCls()}>{sched}</td>
                    <td className={dataTdCls()}>{when(job.startedAt)}</td>
                    <td className={dataTdCls()}>
                      {status ? (
                        <>
                          <Tag tone={tagTone(tone)}>{status}</Tag>
                          {owner || job.code ? (
                            <span className={hint}>
                              {" "}
                              {owner}
                              {job.code ? <code className={code}>{job.code}</code> : null}
                            </span>
                          ) : null}
                        </>
                      ) : (
                        "-"
                      )}
                    </td>
                  </tr>
                );
              })}
              {worker.jobs.length === 0 && (
                <tr>
                  <td colSpan={5} className={`${dataTdCls()} text-fg-muted`}>
                    {T.workerNoRuns}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <SettingRow
        title={
          <>
            {T.notificationPermissionTitle}{" "}
            <Tag tone={state.notificationPermission === "allowed" ? "positive" : "neutral"}>
              {
                {
                  allowed: T.notificationPermissionAllowed,
                  denied: T.notificationPermissionDenied,
                  pending: T.notificationPermissionPending,
                  system: T.notificationPermissionSystem,
                  unavailable: T.notificationPermissionUnavailable,
                }[state.notificationPermission]
              }
            </Tag>
          </>
        }
        action={
          state.notificationPermission === "pending" ? (
            <Button
              disabled={state.notificationPermissionBusy}
              onPress={() => void state.onNotificationPermissionRequested()}
            >
              {T.notificationPermissionRequest}
            </Button>
          ) : null
        }
      />
      <div className={foot}>{S.workerFoot}</div>
    </>
  );
}

function SecretsSection() {
  const unknown = <Tag title={S.unknownStateTitle}>{S.unknownState}</Tag>;
  return (
    <>
      <SettingRow
        title={
          <>
            {S.ebKey} {unknown}
          </>
        }
        detail={S.ebKeyHint}
      />
      <SettingRow title={S.apiToken} detail={S.apiTokenHint} />
      <div className={foot}>{S.secretsFoot}</div>
    </>
  );
}

function AppSection({ state }: { state: SettingsScreenState }) {
  const updater = state.updater;
  const ready = updater.availability === "ready";
  const auto = state.preferences.updatesAuto ?? false;
  return (
    <KeyValues
      rows={[
        {
          key: "theme",
          label: S.theme,
          value: (
            <>
              <Seg
                label={S.theme}
                items={[
                  [S.themeSystem, "system"],
                  [S.themeLight, "light"],
                  [S.themeDark, "dark"],
                ]}
                value={state.preferences.theme ?? "system"}
                onChange={(theme) => void state.onThemePicked(theme)}
              />
              <span className={hint}>{S.themeHint}</span>
            </>
          ),
        },
        {
          key: "language",
          label: S.language,
          value: (
            <>
              <Seg
                label={S.language}
                items={[
                  [S.languageSystem, "system"],
                  [LANG_NAME.pl, "pl"],
                  [LANG_NAME.en, "en"],
                ]}
                value={state.preferences.languagePin ?? "system"}
                onChange={(pin) => void state.onLanguagePicked(pin)}
              />
              <span className={hint}>{S.languageHint}</span>
            </>
          ),
        },
        { key: "version", label: S.version, value: ready ? updater.current : "-" },
        ...(ready
          ? [
              {
                key: "updates",
                label: S.updates,
                value: (
                  <>
                    <Switch
                      on={auto}
                      disabled={state.updaterBusy}
                      label={S.updatesDaily}
                      title={S.updatesDailyTitle}
                      onChange={(on) => void state.onUpdatesAutoPicked(on)}
                    />
                    <span className={hint}>{S.updatesDailyHint(auto)}</span>
                    <Button
                      className="ml-2.5"
                      disabled={state.updaterBusy}
                      onPress={() => void state.onCheckUpdates()}
                    >
                      {S.updatesCheck}
                    </Button>
                  </>
                ),
              },
            ]
          : []),
      ]}
    />
  );
}
