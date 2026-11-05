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
  hostSettingsInfo,
  mcpAudit,
  saveProfile,
  toggledModules,
  workspaceApply,
  workspaceInspect,
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
  readNotificationPermission,
  requestNotificationPermission,
} from "../../notificationBridge.js";
import { createServiceStatusCoordinator, type DesktopServiceStatus } from "../../serviceBridge.js";
import { commandFailure, useDurableCommands } from "../useDurableCommand.js";
import { T } from "./Settings.strings.js";

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
interface ScopedConnectorState {
  readonly vault: string;
  readonly snapshot: ConnectorSettingsSnapshot | null;
  readonly busy: boolean;
}
interface ConnectorScope {
  readonly vault: string;
  readonly generation: number;
}

export function connectorStateForVault(state: ScopedConnectorState, vault: string) {
  return state.vault === vault ? state : { vault, snapshot: null, busy: false };
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
  const [updatePoll, setUpdatePoll] = useState(0);
  const updater = useQuery(updateStatus, { poll: updatePoll });
  const update = useUiAction(updateAction);
  const [since, setSince] = useState(() => new Date(Date.now() - 7 * 86_400_000).toISOString());
  const audit = useQuery(mcpAudit, { vault, since, privacy: ownerIncognito });
  const [hostPoll, setHostPoll] = useState(0);
  const hostInfo = useQuery(hostSettingsInfo, { poll: hostPoll, privacy: ownerIncognito });
  const [service, setService] = useState<DesktopServiceStatus>({ state: "unavailable" });
  const [serviceBusy, setServiceBusy] = useState(false);
  const [notificationPermission, setNotificationPermission] =
    useState<NotificationPermissionStatus>("unavailable");
  const [notificationPermissionBusy, setNotificationPermissionBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void readNotificationPermission().then((status) => {
      if (current) setNotificationPermission(status);
    });
    return () => {
      current = false;
    };
  }, [hostPoll]);
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
    void serviceFlow.poll();
    return () => serviceFlow.invalidate();
  }, [hostPoll, serviceFlow]);
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
  useEffect(() => {
    const timer = setInterval(() => setHostPoll((value) => value + 1), 60_000);
    return () => clearInterval(timer);
  }, []);
  const proposals = useQuery(proposalList, { status: "pending", privacy: ownerIncognito });
  const save = useCommand(saveProfile);
  const setEnabled = useCommand(setModules);
  const setPrivacy = useCommand(setProfileSettings);
  const setPrefs = useCommand(setDevicePreferences);
  const durable = useDurableCommands();
  const inspect = useUiAction(workspaceInspect);
  const apply = useUiAction(workspaceApply);
  const connectorAction = useUiAction(connectorSettings);
  const connectorScope = useRef({ vault, generation: 0 });
  const connectorRunRef = useRef(connectorAction.run);
  useLayoutEffect(() => {
    if (connectorScope.current.vault !== vault)
      connectorScope.current = { vault, generation: connectorScope.current.generation + 1 };
    connectorRunRef.current = connectorAction.run;
  });
  const [connectorState, setConnectorState] = useState<ScopedConnectorState>({
    vault,
    snapshot: null,
    busy: false,
  });
  const visibleConnectorState = connectorStateForVault(connectorState, vault);
  const connectorSnapshot = visibleConnectorState.snapshot;
  const connectorBusy = visibleConnectorState.busy;
  const currentConnectorScope = (captured: ConnectorScope) =>
    connectorScopeMatches(connectorScope.current, captured);
  const setConnectorScoped = (
    captured: ConnectorScope,
    update: (old: ConnectorSettingsSnapshot | null) => ConnectorSettingsSnapshot | null,
  ) => {
    if (!currentConnectorScope(captured)) return;
    setConnectorState((previous) => ({
      vault: captured.vault,
      snapshot: update(previous.vault === captured.vault ? previous.snapshot : null),
      busy: previous.vault === captured.vault ? previous.busy : false,
    }));
  };
  const setConnectorBusyScoped = (captured: ConnectorScope, busy: boolean) => {
    if (!currentConnectorScope(captured)) return;
    setConnectorState((previous) => ({
      vault: captured.vault,
      snapshot: previous.vault === captured.vault ? previous.snapshot : null,
      busy,
    }));
  };
  async function refreshConnectors() {
    if (connectorBusy) return;
    const captured = connectorScope.current;
    setConnectorBusyScoped(captured, true);
    try {
      const result = await connectorAction.run({ op: "list" });
      setConnectorScoped(captured, () =>
        result.status === "completed" ? (result.value as ConnectorSettingsSnapshot) : null,
      );
    } finally {
      setConnectorBusyScoped(captured, false);
    }
  }
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
      if (result.kind === "installed" && currentConnectorScope(captured)) {
        const listed = await connectorAction.run({ op: "list" });
        if (currentConnectorScope(captured)) {
          if (listed.status === "completed")
            setConnectorScoped(captured, () => listed.value as ConnectorSettingsSnapshot);
          setNotice(T.connectorInstalled);
        }
      }
    } catch {
      if (currentConnectorScope(captured)) setNotice(T.connectorUnknown);
    } finally {
      setConnectorBusyScoped(captured, false);
    }
  }
  async function onConnectorAction(input: ConnectorSettingsInput) {
    if (connectorBusy) return;
    const captured = connectorScope.current;
    setConnectorBusyScoped(captured, true);
    try {
      const result = await connectorAction.run(input);
      if (!currentConnectorScope(captured)) return;
      if (result.status === "completed") {
        const listed = await connectorAction.run({ op: "list" });
        if (!currentConnectorScope(captured)) return;
        if (listed.status === "completed")
          setConnectorScoped(captured, () => listed.value as ConnectorSettingsSnapshot);
        setNotice(connectorActionMessage(input, result));
      } else setNotice(connectorActionMessage(input, result));
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
  useEffect(() => {
    const captured = connectorScope.current;
    const timer = setTimeout(() => {
      void connectorRunRef.current({ op: "list" }).then((result) => {
        if (!connectorScopeMatches(connectorScope.current, captured)) return;
        setConnectorState((previous) => ({
          vault: captured.vault,
          snapshot:
            result.status === "completed" ? (result.value as ConnectorSettingsSnapshot) : null,
          busy: previous.vault === captured.vault ? previous.busy : false,
        }));
      });
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [vault]);
  const [notice, setNotice] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceSummary>({
    availability: "unavailable",
    reason: "source_unbound",
  });
  const [workspaceBusy, setWorkspaceBusy] = useState(false);
  const [workspacePath, setWorkspacePath] = useState("");
  const [editingPath, setEditingPath] = useState(false);
  const [routinePermissions, setRoutinePermissions] = useState(false);
  const workspaceRun = useRef(0);
  const workspaceOperation = useRef<"idle" | "read" | "apply">("idle");
  const workspaceRefreshAfterApply = useRef(false);
  const workspacePathDirty = useRef(false);
  const routinePermissionsDirty = useRef(false);
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
  const hydrateWorkspaceDrafts = (next: WorkspaceSummary) => {
    if (next.availability !== "ready") return;
    if (!workspacePathDirty.current) setWorkspacePath(next.path ?? "");
    if (!routinePermissionsDirty.current) setRoutinePermissions(next.routinePermissions ?? false);
  };
  const moduleSignature = modules.map((m) => `${m.id}:${m.enabled}`).join("|");
  const inspectRun = useRef(inspect.run);
  useEffect(() => {
    inspectRun.current = inspect.run;
  }, [inspect.run]);
  useEffect(() => {
    if (workspaceOperation.current === "apply") {
      workspaceRefreshAfterApply.current = true;
      return;
    }
    let active = true;
    const request = ++workspaceRun.current;
    workspaceOperation.current = "read";
    setWorkspaceBusy(true);
    void inspectRun
      .current({})
      .then((result) => {
        if (!active || workspaceRun.current !== request) return;
        const next =
          result.status === "completed"
            ? workspaceStatus(result.value)
            : { availability: "unavailable" as const, reason: result.status };
        setWorkspace(next);
        hydrateWorkspaceDrafts(next);
      })
      .catch(() => {
        if (active && workspaceRun.current === request)
          setWorkspace({ availability: "unavailable", reason: "read_failed" });
      })
      .finally(() => {
        if (active && workspaceRun.current === request) {
          workspaceOperation.current = "idle";
          setWorkspaceBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [vault, current?.mcpPrivacy, current?.baseCurrency, moduleSignature]);
  const refreshWorkspace = async () => {
    if (workspaceOperation.current !== "idle") return;
    const request = ++workspaceRun.current;
    workspaceOperation.current = "read";
    setWorkspaceBusy(true);
    try {
      const result = await inspect.run({});
      if (workspaceRun.current !== request) return;
      const next =
        result.status === "completed"
          ? workspaceStatus(result.value)
          : { availability: "unavailable" as const, reason: result.status };
      setWorkspace(next);
      hydrateWorkspaceDrafts(next);
    } catch {
      if (workspaceRun.current === request)
        setWorkspace({ availability: "unavailable", reason: "read_failed" });
    } finally {
      if (workspaceRun.current === request) {
        workspaceOperation.current = "idle";
        setWorkspaceBusy(false);
      }
    }
  };
  // One click applies one change, as in the Python app's workspace panel: `path` null = keep the folder
  // (Update, Replace changed, the routine switch), a string = create there / move; omitted = the edited path
  // while the folder field is open. `force` (replace locally changed files) is off unless asked for;
  // `routinePermissions` defaults to its draft.
  const saveWorkspace = async (run: WorkspaceRun = {}) => {
    if (workspaceOperation.current !== "idle") return;
    const path = run.path === undefined ? (editingPath ? workspacePath : null) : run.path;
    if (path !== null && workspace.configured && !path.trim()) {
      setNotice(T.workspacePathRequired);
      return;
    }
    workspaceOperation.current = "apply";
    setWorkspaceBusy(true);
    try {
      const result = await apply.run({
        ...(path !== null ? { path } : {}),
        force: run.force ?? false,
        routinePermissions: run.routinePermissions ?? routinePermissions,
      });
      if (result.status !== "completed") {
        setNotice(result.status === "outcome_unknown" ? T.workspaceUnknown : T.saveFailed);
      } else if (result.value && typeof result.value === "object" && "kind" in result.value) {
        const value = result.value as { kind: string; code?: string; status?: unknown };
        if (value.status) {
          const next = workspaceStatus(value.status);
          setWorkspace(next);
          if (value.kind === "completed") {
            workspacePathDirty.current = false;
            routinePermissionsDirty.current = false;
            hydrateWorkspaceDrafts(next);
          }
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
      workspaceOperation.current = "idle";
      setWorkspaceBusy(false);
      if (workspaceRefreshAfterApply.current) {
        workspaceRefreshAfterApply.current = false;
        queueMicrotask(() => {
          void refreshWorkspace();
        });
      }
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
    setUpdatePoll((value) => value + 1);
    if (result.status !== "completed" || result.value.kind !== "completed")
      setNotice(result.status === "outcome_unknown" ? T.workspaceUnknown : T.updatesUnavailable);
  };
  const setUpdatesAuto = async (enabled: boolean) => {
    const result = await update.run({ action: "auto", enabled });
    if (result.status !== "completed" || result.value.kind !== "completed") {
      setNotice(T.updatesUnavailable);
      return;
    }
    const saved = await durable.run("preferences", setPrefs, { updatesAuto: enabled });
    setNotice(saved.kind === "completed" ? T.saved : commandFailure(saved, T.saveFailed));
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
    connectorBusy,
    connectorAccounts,
    bindConnector,
    refreshConnectors,
    installConnector,
    onConnectorAction,
    workspaceBusy,
    workspacePath,
    editingPath,
    routinePermissions,
    setWorkspacePath: (value: string) => {
      workspacePathDirty.current = true;
      setWorkspacePath(value);
    },
    setEditingPath: (value: boolean) => {
      setEditingPath(value);
      if (!value) {
        workspacePathDirty.current = false;
        hydrateWorkspaceDrafts(workspace);
      }
    },
    setRoutinePermissions: (value: boolean) => {
      routinePermissionsDirty.current = true;
      setRoutinePermissions(value);
    },
    refreshWorkspace,
    saveWorkspace,
    onWorkspaceCopied: copyWorkspaceText,
    audit: auditDisplay,
    onAuditRefreshed: () => setSince(new Date(Date.now() - 7 * 86_400_000).toISOString()),
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
    onHostInfoRefreshed: () => setHostPoll((value) => value + 1),
    onDataDirCopied: copyDataDir,
    updater,
    updaterBusy: update.isPending,
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
