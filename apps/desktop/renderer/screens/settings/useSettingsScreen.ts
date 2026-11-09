import { builtinRegistry } from "@cashu/domain/core";
import { lang, setLanguage } from "@cashu/i18n";
import { S as ASSETS } from "@cashu/i18n/assets/index.strings";
import { S as BUDGET } from "@cashu/i18n/budget/index.strings";
import { S as INVESTMENTS } from "@cashu/i18n/investments/index.strings";
import { S as LOANS } from "@cashu/i18n/loans/index.strings";
import { setModules, setProfileSettings } from "@cashu/store";
import { profile } from "@cashu/store/core";
import { proposalList } from "@cashu/store/core/desktop-proposals";
import {
  type ConnectorSettingsInput,
  type ConnectorSettingsSnapshot,
  connectorSettings,
  connectorSettingsSnapshot,
  hostSettingsInfo,
  mcpAudit,
  saveProfile,
  toggledModules,
  workspaceApply,
  workspaceStatus as workspaceStatusQuery,
} from "@cashu/store/core/desktop-settings";
import {
  devicePreferences,
  setDevicePreferences,
  updateAction,
  updateStatus,
} from "@cashu/store/device";
import { overviewQueries, profileIdentity } from "@cashu/store/overview";
import { useCommand, useProfile, useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { hmLocal, localDay } from "@cashu/ui-logic/core/time";
import { useForm } from "@tanstack/react-form";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { connectorsBridge } from "../../connectorsBridge.js";
import {
  type NotificationPermissionStatus,
  onNotificationPermission,
  readNotificationPermission,
  requestNotificationPermission,
} from "../../notificationBridge.js";
import {
  createServiceStatusCoordinator,
  type DesktopServiceStatus,
  onServiceStatus,
} from "../../serviceBridge.js";
import { useCalendarDay } from "../../shell/useCalendarDay.js";
import { commandFailure, useDurableCommands } from "../useDurableCommand.js";
import { useConnectorActivity } from "./connectors/useConnectorActivity.js";
import { T } from "./Settings.strings.js";

/** Start of the audit log's 7-day window: local midnight six days before `day` (YYYY-MM-DD), so the count covers
 * today and the six days before it and moves only when the calendar day does. */
function auditWindowStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) - 6).toISOString();
}

/** Old core/registry.ts MODULES: the navigation order of the module rows (unknown ids after, in their order). */
const MODULE_ORDER = ["budget", "loans", "assets", "investments"];
function orderModules<M extends { id: string }>(items: readonly M[]): M[] {
  const rank = (id: string) => {
    const i = MODULE_ORDER.indexOf(id);
    return i < 0 ? MODULE_ORDER.length : i;
  };
  return items
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m.id) - rank(b.m.id) || a.i - b.i)
    .map(({ m }) => m);
}
/** Old ModuleDef `short` (each module's index.tsx catalog): the module row's line. */
function moduleShort(id: string): string | undefined {
  if (id === "budget") return BUDGET.short;
  if (id === "loans") return LOANS.short;
  if (id === "assets") return ASSETS.desc;
  if (id === "investments") return INVESTMENTS.short;
  return undefined;
}

const registry = builtinRegistry();
const modulesQuery = overviewQueries({ prices: null }).moduleStates;

interface WorkspaceSummary {
  readonly availability: "ready" | "unavailable";
  readonly reason?: string;
  readonly path?: string;
  readonly defaultPath?: string;
  readonly configured?: boolean;
  readonly custom?: boolean;
  readonly exists?: boolean;
  readonly folderExists?: boolean;
  readonly conflict?: string | null;
  readonly upToDate?: boolean;
  readonly managedVersion?: string | null;
  readonly currentVersion?: string;
  readonly updatedAt?: string | null;
  readonly outdated?: readonly {
    readonly kind: string;
    readonly name: string;
    readonly reason: string;
  }[];
  readonly skills?: readonly {
    readonly name: string;
    readonly module: string | null;
    readonly version: string;
    readonly state: string;
  }[];
  readonly skillsSource?: boolean;
  readonly claudeCommand?: string | null;
  readonly routineCommand?: string | null;
  readonly routinePermissions?: boolean;
  readonly mcpCommandStale?: boolean;
}
/** One workspace write (see `saveWorkspace`). */
export interface WorkspaceRun {
  readonly path?: string | null;
  readonly force?: boolean;
  readonly routinePermissions?: boolean;
}
type ConnectorSummary = ConnectorSettingsSnapshot["connectors"][number];
type ConnectorDraft = Readonly<Record<string, string | boolean>>;
interface ConnectorScope {
  readonly vault: string;
  readonly generation: number;
}

export function connectorScopeMatches(current: ConnectorScope, captured: ConnectorScope): boolean {
  return current.vault === captured.vault && current.generation === captured.generation;
}

export function connectorActionMessage(
  input: ConnectorSettingsInput,
  result: { readonly status: string; readonly value?: unknown },
) {
  if (result.status === "outcome_unknown") return T.connectorUnknown;
  if (result.status !== "completed") return T.connectorFailed;
  const runStatus =
    input.op === "run" &&
    result.value &&
    typeof result.value === "object" &&
    "status" in result.value
      ? result.value.status
      : null;
  return runStatus === "failed" || runStatus === "partial"
    ? T.connectorRunFailed
    : T.connectorSaved;
}

/** A fetch run that did not finish clean (`failed` / `partial`), for the binding row's failure block; null = clean. */
function connectorRunFailure(
  input: ConnectorSettingsInput,
  result: { readonly status: string; readonly value?: unknown },
): ConnectorRunFailure | null {
  if (input.op !== "run" || result.status !== "completed") return null;
  const value = result.value as { status?: unknown; code?: unknown } | null | undefined;
  const status = value?.status;
  if (status !== "failed" && status !== "partial") return null;
  return { status, code: typeof value?.code === "string" ? value.code : null };
}
export interface ConnectorRunFailure {
  readonly status: "failed" | "partial";
  readonly code: string | null;
}

export function connectorEligibleAccounts(
  snapshot: ConnectorSettingsSnapshot | null,
  connector: ConnectorSummary,
) {
  return (
    snapshot?.accounts.filter((account) =>
      connector.module === "investments"
        ? account.type === "brokerage"
        : account.type !== "brokerage",
    ) ?? []
  );
}

export function connectorParams(
  connector: ConnectorSummary,
  draft: ConnectorDraft,
): Readonly<Record<string, string | number | boolean>> | null {
  const result: Record<string, string | number | boolean> = {};
  for (const spec of connector.params) {
    const value = draft[spec.id];
    if (spec.type === "boolean") {
      result[spec.id] = value === true;
      continue;
    }
    if (value === undefined || value === "") {
      if (spec.required) return null;
      continue;
    }
    if (typeof value !== "string") return null;
    if (spec.type === "number") {
      const number = Number(value);
      if (!Number.isFinite(number)) return null;
      result[spec.id] = number;
    } else if (spec.type === "date") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
      result[spec.id] = value;
    } else result[spec.id] = value;
  }
  return result;
}
const workspaceStatus = (value: unknown): WorkspaceSummary => {
  if (!value || typeof value !== "object" || !("availability" in value))
    return { availability: "unavailable", reason: "invalid_status" };
  const status = value as WorkspaceSummary;
  return status.availability === "ready" || status.availability === "unavailable"
    ? status
    : { availability: "unavailable", reason: "invalid_status" };
};

export function useSettingsScreen(
  onProposalOpened: (gid: string) => void,
  onModuleConfigured: (id: string) => void,
) {
  const vault = useProfile();
  const { privacy: ownerIncognito } = useUiEnv();
  const identity = useQuery(profileIdentity);
  const current = useQuery(profile);
  const modules = useQuery(modulesQuery);
  const preferences = useQuery(devicePreferences);
  // Live device queries: main re-pushes the updater status, the host re-pushes its info when the worker
  // status changes. Nothing on this screen polls.
  const updater = useQuery(updateStatus);
  const update = useUiAction(updateAction);
  // The call log is pushed on every MCP call; its 7-day count rolls with the calendar day (no Odśwież).
  const since = auditWindowStart(useCalendarDay());
  const audit = useQuery(mcpAudit, { vault, since, privacy: ownerIncognito });
  const connectorActivity = useConnectorActivity(vault, ownerIncognito);
  const hostInfo = useQuery(hostSettingsInfo, { privacy: ownerIncognito });
  const [service, setService] = useState<DesktopServiceStatus>({ state: "unavailable" });
  const [serviceBusy, setServiceBusy] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermissionStatus>("unavailable");
  const [notificationPermissionBusy, setNotificationPermissionBusy] = useState(false);
  useEffect(() => {
    // The first read, then main's pushes (it re-checks when the window gets focus back).
    let initial = true;
    void readNotificationPermission().then((status) => {
      if (initial) setNotificationPermission(status);
    });
    const stop = onNotificationPermission((status) => {
      initial = false;
      setNotificationPermission(status);
    });
    return () => {
      initial = false;
      stop();
    };
  }, []);
  async function onNotificationPermissionRequested(): Promise<void> {
    if (notificationPermissionBusy || notificationPermission !== "pending") return;
    setNotificationPermissionBusy(true);
    try {
      setNotificationPermission(await requestNotificationPermission());
    } finally {
      setNotificationPermissionBusy(false);
    }
  }
  const [serviceFlow] = useState(() => createServiceStatusCoordinator(setService));
  useEffect(() => {
    void serviceFlow.load();
    const stop = onServiceStatus((status) => serviceFlow.pushed(status));
    return () => {
      stop();
      serviceFlow.invalidate();
    };
  }, [serviceFlow]);
  async function onServiceEnabled(enabled: boolean): Promise<void> {
    if (serviceFlow.busy || !["off", "enabled", "requires_approval"].includes(service.state))
      return;
    if (service.state === "requires_approval" && enabled) return;
    setServiceBusy(true);
    try {
      await serviceFlow.toggle(enabled);
    } finally {
      setServiceBusy(false);
    }
  }
  const auditDisplay = {
    ...audit,
    calls: audit.calls.map((call) => ({
      ...call,
      calledDay: localDay(call.calledAt),
      calledTime: hmLocal(call.calledAt),
    })),
  };
  const workerDisplay =
    hostInfo.availability === "ready" && hostInfo.worker
      ? {
          ...hostInfo.worker,
          nextRunDay: localDay(hostInfo.worker.nextRunAt),
          nextRunTime: hmLocal(hostInfo.worker.nextRunAt),
          lastTickDay: localDay(hostInfo.worker.lastTickAt),
          lastTickTime: hmLocal(hostInfo.worker.lastTickAt),
          jobs: hostInfo.worker.jobs.map((job) => ({
            ...job,
            startedDay: localDay(job.startedAt),
            startedTime: hmLocal(job.startedAt),
          })),
        }
      : null;
  const proposals = useQuery(proposalList, { status: "pending", privacy: ownerIncognito });
  const save = useCommand(saveProfile);
  const setEnabled = useCommand(setModules);
  const setPrivacy = useCommand(setProfileSettings);
  const setPrefs = useCommand(setDevicePreferences);
  const durable = useDurableCommands();
  // The workspace status is a live host query (re-inspected after a write, a profile change or an edit on disk).
  const liveWorkspace = useQuery(workspaceStatusQuery);
  const apply = useUiAction(workspaceApply);
  const connectorAction = useUiAction(connectorSettings);
  // The installed connectors, accounts and bindings: a live vault query the host re-runs when its catalog changes
  // (an install, also from MCP or the CLI, an approval, a removal, an edit in its directory) or a binding changes;
  // nothing here re-reads it.
  const connectorSnapshot = useQuery(connectorSettingsSnapshot);
  const connectorScope = useRef({ vault, generation: 0 });
  useLayoutEffect(() => {
    if (connectorScope.current.vault !== vault)
      connectorScope.current = { vault, generation: connectorScope.current.generation + 1 };
  });
  // The vault whose owner action is in flight: a switch to another profile shows that profile idle.
  const [connectorBusyVault, setConnectorBusyVault] = useState<string | null>(null);
  const connectorBusy = connectorBusyVault === vault;
  const currentConnectorScope = (captured: ConnectorScope) =>
    connectorScopeMatches(connectorScope.current, captured);
  const setConnectorBusyScoped = (captured: ConnectorScope, busy: boolean) => {
    if (!currentConnectorScope(captured)) return;
    setConnectorBusyVault(busy ? captured.vault : null);
  };
  async function installConnector() {
    if (connectorBusy) return;
    const captured = connectorScope.current;
    const bridge = connectorsBridge();
    if (!bridge) {
      setNotice(T.connectorFailed);
      return;
    }
    setConnectorBusyScoped(captured, true);
    try {
      const result = await bridge.installPending();
      if (result.kind === "installed" && currentConnectorScope(captured))
        setNotice(T.connectorInstalled);
    } catch {
      if (currentConnectorScope(captured)) setNotice(T.connectorUnknown);
    } finally {
      setConnectorBusyScoped(captured, false);
    }
  }
  const [connectorRuns, setConnectorRuns] = useState<Readonly<Record<string, ConnectorRunFailure>>>(
    {},
  );
  async function onConnectorAction(input: ConnectorSettingsInput) {
    if (connectorBusy) return;
    const captured = connectorScope.current;
    setConnectorBusyScoped(captured, true);
    try {
      const result = await connectorAction.run(input);
      if (!currentConnectorScope(captured)) return;
      if (input.op === "run") {
        const failure = connectorRunFailure(input, result);
        const key = `${captured.vault}:${input.binding}`;
        setConnectorRuns((old) => {
          const next = { ...old };
          if (failure) next[key] = failure;
          else delete next[key];
          return next;
        });
      }
      setNotice(connectorActionMessage(input, result));
    } finally {
      setConnectorBusyScoped(captured, false);
    }
  }
  const connectorAccounts = (connector: ConnectorSummary) =>
    connectorEligibleAccounts(connectorSnapshot, connector);
  async function bindConnector(
    connector: ConnectorSummary,
    account: string,
    draft: ConnectorDraft,
    autoCommit: boolean,
  ) {
    const params = connectorParams(connector, draft);
    if (!params || !connectorAccounts(connector).some((item) => item.gid === account)) {
      setNotice(T.connectorInvalidParams);
      return;
    }
    await onConnectorAction({ op: "bind", id: connector.id, account, params, autoCommit });
  }
  const [notice, setNotice] = useState<string | null>(null);
  const workspace: WorkspaceSummary =
    liveWorkspace.status === "ready"
      ? workspaceStatus(liveWorkspace.workspace)
      : { availability: "unavailable", reason: "checking" };
  // The workspace write in flight: the routine switch shows its own spinner, the buttons theirs.
  const [applying, setApplying] = useState<"routine" | "write" | null>(null);
  const workspaceBusy =
    applying !== null ||
    liveWorkspace.status === "loading" ||
    (liveWorkspace.status === "ready" && liveWorkspace.checking);
  // Drafts of the folder field and the routine switch, per vault; null follows the live workspace.
  const [pathDraft, setPathDraft] = useState<{ vault: string; path: string } | null>(null);
  const [routineDraft, setRoutineDraft] = useState<{ vault: string; on: boolean } | null>(null);
  const workspacePath =
    pathDraft?.vault === vault
      ? pathDraft.path
      : workspace.availability === "ready"
        ? (workspace.path ?? "")
        : "";
  const routinePermissions =
    routineDraft?.vault === vault ? routineDraft.on : (workspace.routinePermissions ?? false);
  const [editingPath, setEditingPath] = useState(false);
  const workspaceApplying = useRef(false);
  const moduleQueue = useRef(Promise.resolve());
  const desiredModules = useRef<string[]>([]);
  const profileForm = useForm({
    defaultValues: { name: current?.name ?? "", baseCurrency: current?.baseCurrency ?? "PLN" },
    validators: {
      onSubmit: ({ value }) =>
        value.name.trim().length > 0 &&
        value.name.trim().length <= 40 &&
        /^[A-Za-z]{3}$/u.test(value.baseCurrency) &&
        saveProfile.input.safeParse(value).success
          ? undefined
          : T.invalidProfile,
    },
    onSubmit: async ({ value }) => {
      const result = await durable.run("profile", save, value);
      setNotice(result.kind === "completed" ? T.saved : commandFailure(result, T.saveFailed));
    },
  });
  useEffect(() => {
    if (!durable.uncertain("profile"))
      profileForm.reset({
        name: current?.name ?? "",
        baseCurrency: current?.baseCurrency ?? "PLN",
      });
  }, [profileForm, vault, current?.name, current?.baseCurrency, durable]);
  useEffect(() => {
    desiredModules.current = modules.filter((m) => m.enabled).map((m) => m.id);
  }, [vault, modules]);
  // One click applies one change, as in the Python app's workspace panel: `path` null = keep the folder
  // (Update, Replace changed, the routine switch), a string = create there / move; omitted = the edited path
  // while the folder field is open. `force` (replace locally changed files) is off unless asked for;
  // `routinePermissions` defaults to its draft.
  const saveWorkspace = async (run: WorkspaceRun = {}) => {
    if (workspaceApplying.current) return;
    const path = run.path === undefined ? (editingPath ? workspacePath : null) : run.path;
    if (path !== null && workspace.configured && !path.trim()) {
      setNotice(T.workspacePathRequired);
      return;
    }
    workspaceApplying.current = true;
    setApplying(run.routinePermissions === undefined ? "write" : "routine");
    try {
      const result = await apply.run({
        ...(path !== null ? { path } : {}),
        force: run.force ?? false,
        routinePermissions: run.routinePermissions ?? routinePermissions,
      });
      if (result.status !== "completed") {
        setNotice(result.status === "outcome_unknown" ? T.workspaceUnknown : T.saveFailed);
      } else if (result.value && typeof result.value === "object" && "kind" in result.value) {
        const value = result.value as { kind: string; code?: string };
        // The status arrives by push; a completed write drops the drafts so they follow it.
        if (value.kind === "completed") {
          setPathDraft(null);
          setRoutineDraft(null);
        }
        setNotice(
          value.kind === "completed"
            ? T.saved
            : value.kind === "partial"
              ? T.workspacePartial
              : value.kind === "outcome_unknown"
                ? T.workspaceUnknown
                : value.code === "path_relative"
                  ? T.workspacePathRelative
                  : value.code === "path_home"
                    ? T.workspacePathHome
                    : value.code === "path_hidden"
                      ? T.workspacePathHidden
                      : value.code === "path_symlink"
                        ? T.workspacePathSymlink
                        : value.code === "workspace_taken"
                          ? T.workspaceTaken
                          : value.code === "busy"
                            ? T.workspaceBusy
                            : value.code === "write_failed"
                              ? T.workspaceWriteFailed
                              : T.saveFailed,
        );
        if (value.kind === "completed") setEditingPath(false);
      }
    } finally {
      workspaceApplying.current = false;
      setApplying(null);
    }
  };
  const toggleModule = (id: string) => {
    const next = toggledModules(desiredModules.current, id);
    if (!next) return;
    desiredModules.current = next;
    moduleQueue.current = moduleQueue.current
      .then(async () => {
        const result = await durable.run("modules", setEnabled, { moduleIds: next });
        if (result.kind !== "completed") setNotice(commandFailure(result, T.saveFailed));
      })
      .catch(() => setNotice(T.saveFailed));
  };
  const setMcpPrivacy = async (choice: "strict" | "amounts") => {
    const result = await durable.run("mcp-privacy", setPrivacy, { mcpPrivacy: choice });
    setNotice(result.kind === "completed" ? T.saved : commandFailure(result, T.saveFailed));
  };
  const setTheme = async (choice: "system" | "light" | "dark") => {
    const result = await durable.run("preferences", setPrefs, { theme: choice });
    if (result.kind === "completed") {
      document.documentElement.classList.toggle("dark", choice === "dark");
      document.documentElement.classList.toggle("light", choice === "light");
    }
    setNotice(result.kind === "completed" ? T.saved : commandFailure(result, T.saveFailed));
  };
  const setLanguagePin = async (choice: "system" | "pl" | "en") => {
    const result = await durable.run("preferences", setPrefs, { languagePin: choice });
    if (result.kind !== "completed") {
      setNotice(commandFailure(result, T.saveFailed));
      return;
    }
    setLanguage(choice === "system" ? null : choice);
  };
  const checkUpdates = async () => {
    const result = await update.run({ action: "check" });
    if (result.status !== "completed" || result.value.kind !== "completed")
      setNotice(result.status === "outcome_unknown" ? T.workspaceUnknown : T.updatesUnavailable);
  };
  // "Sprawdzaj codziennie" lives in Electron main's update preferences; the switch shows
  // updateStatus.autoCheck, which main re-pushes after the change.
  const [updatesAutoBusy, setUpdatesAutoBusy] = useState(false);
  const setUpdatesAuto = async (enabled: boolean) => {
    setUpdatesAutoBusy(true);
    try {
      const result = await update.run({ action: "auto", enabled });
      setNotice(
        result.status === "completed" && result.value.kind === "completed"
          ? T.saved
          : T.updatesUnavailable,
      );
    } finally {
      setUpdatesAutoBusy(false);
    }
  };
  const copyDataDir = async () => {
    if (hostInfo.availability !== "ready" || !hostInfo.dataDir) return;
    try {
      await navigator.clipboard.writeText(hostInfo.dataDir);
      setNotice(T.copied);
    } catch {
      setNotice(T.copyFailed);
    }
  };
  const copyWorkspaceText = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(T.copied);
    } catch {
      setNotice(T.copyFailed);
    }
  };
  return {
    vault,
    identity,
    current,
    profileForm,
    profileBusy: save.isPending,
    modules: orderModules(modules).map((state) => {
      const spec = registry.modules.get(state.id);
      return {
        ...state,
        available: spec?.available ?? false,
        name: lang() === "pl" ? (spec?.name ?? state.id) : (spec?.nameEn ?? spec?.name ?? state.id),
        description:
          moduleShort(state.id) ??
          (lang() === "pl"
            ? (spec?.description ?? "")
            : (spec?.descriptionEn ?? spec?.description ?? "")),
        dependsOn: spec?.dependsOn ?? [],
      };
    }),
    moduleBusy: setEnabled.isPending,
    onModuleToggled: toggleModule,
    onModuleConfigured,
    privacyBusy: setPrivacy.isPending,
    onMcpPrivacyPicked: setMcpPrivacy,
    workspace,
    connectorSnapshot,
    connectorVault: vault,
    connectorActivity,
    connectorBusy,
    connectorAccounts,
    /** The last unclean fetch run of a binding in this vault (old RunError under the binding row). */
    connectorRunFailure: (binding: string) => connectorRuns[`${vault}:${binding}`] ?? null,
    bindConnector,
    installConnector,
    onConnectorAction,
    workspaceBusy,
    /** The routine switch's write is in flight (its spinner). */
    routineSaving: applying === "routine",
    workspacePath,
    editingPath,
    routinePermissions,
    setWorkspacePath: (value: string) => setPathDraft({ vault, path: value }),
    setEditingPath: (value: boolean) => {
      setEditingPath(value);
      if (!value) setPathDraft(null);
    },
    setRoutinePermissions: (value: boolean) => setRoutineDraft({ vault, on: value }),
    saveWorkspace,
    onWorkspaceCopied: copyWorkspaceText,
    audit: auditDisplay,
    proposals,
    onProposalOpened,
    preferences,
    hostInfo,
    service,
    serviceNextWakeDay: localDay(service.nextWake ?? null),
    serviceNextWakeTime: hmLocal(service.nextWake ?? null),
    serviceBusy,
    onServiceEnabled,
    notificationPermission,
    notificationPermissionBusy,
    onNotificationPermissionRequested,
    worker: workerDisplay,
    onDataDirCopied: copyDataDir,
    updater,
    updaterBusy: update.isPending,
    /** The "check daily" switch's change is in flight (its spinner). */
    updatesAutoBusy,
    onCheckUpdates: checkUpdates,
    onUpdatesAutoPicked: setUpdatesAuto,
    onThemePicked: setTheme,
    onLanguagePicked: setLanguagePin,
    notice,
    onNoticeDismissed: () => setNotice(null),
    ownerIncognito,
  };
}
export type SettingsScreenState = ReturnType<typeof useSettingsScreen>;
