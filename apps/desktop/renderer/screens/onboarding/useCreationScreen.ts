import { builtinRegistry, moduleDescription, moduleName, slugify } from "@cashu/domain/core";
import type { NativeCreationReady } from "@cashu/host-protocol";
import { nativeCreationPrepareParamsSchema } from "@cashu/host-protocol";
import { lang } from "@cashu/i18n";
import { S as Wizard } from "@cashu/i18n/core/Wizard.strings";
import { nModules } from "@cashu/ui-logic/core/format";
import { useForm, useStore } from "@tanstack/react-form";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { CreationBridge } from "../../creationBridge.js";
import { toggleModuleSelection } from "./selection.js";
import { type WorkspaceTarget, workspaceMatches } from "./workspaceMatch.js";
import type { CreationWorkspacePort, CreationWorkspaceStatus } from "./workspacePort.js";

const registry = builtinRegistry();
type Phase =
  | "checking"
  | "unavailable"
  | "profile"
  | "modules"
  | "privacy"
  | "preparing"
  | "recovery"
  | "committing"
  | "pending"
  | "unknown"
  | "restart_possible"
  | "refused"
  | "verifying"
  | "workspace_checking"
  | "workspace_ready"
  | "workspace_applying"
  | "workspace_failed"
  | "workspace_unknown"
  | "workspace_unavailable"
  | "ready";

export interface CreationScreenOptions {
  readonly mode: "first" | "additional";
  readonly bridge: CreationBridge | null;
  readonly onReady: (locator: NativeCreationReady) => Promise<boolean>;
  readonly workspace?: CreationWorkspacePort;
  readonly onComplete?: (locator: NativeCreationReady) => Promise<void> | void;
  readonly onClosed?: () => void;
}

export function useCreationScreen(options: CreationScreenOptions) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [phrase, setPhrase] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [nameError, setNameError] = useState<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
  const [workspaceEnabled, setWorkspaceEnabled] = useState(true);
  const [workspacePath, setWorkspacePath] = useState("");
  const [workspacePathDirty, setWorkspacePathDirty] = useState(false);
  const [routinePermissions, setRoutinePermissions] = useState(false);
  const [workspaceStatus, setWorkspaceStatus] = useState<CreationWorkspaceStatus | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceInspected, setWorkspaceInspected] = useState(false);
  const verified = useRef<NativeCreationReady | null>(null);
  const attemptedWorkspace = useRef<WorkspaceTarget | null>(null);
  const completed = useRef(false);
  const attempt = useRef<{ operationId: string; phraseSession: string | null } | null>(null);
  const lifetime = useRef(0);
  const actionBusy = useRef(false);
  const isCurrent = (generation: number) => generation === lifetime.current;
  const form = useForm({
    defaultValues: {
      name: "",
      baseCurrency: "PLN",
      deviceAlias: "",
      modules: registry.modules.get("budget")?.available ? ["budget"] : ([] as string[]),
      mcpPrivacy: null as "strict" | "amounts" | null,
    },
    onSubmit: async ({ value }) => {
      if (!options.bridge || actionBusy.current) return;
      const parsed = nativeCreationPrepareParamsSchema.safeParse({
        name: value.name.trim(),
        slug: slugify(value.name),
        baseCurrency: value.baseCurrency,
        modules: value.modules,
        mcpPrivacy: value.mcpPrivacy,
        ...(value.deviceAlias.trim() ? { deviceAlias: value.deviceAlias.trim() } : {}),
      });
      if (!parsed.success) {
        setRefusal("invalid_input");
        return;
      }
      actionBusy.current = true;
      const generation = lifetime.current;
      setPhase("preparing");
      try {
        const result = await options.bridge.prepare(parsed.data);
        if (!isCurrent(generation)) return;
        if (result.kind === "refused") {
          setRefusal(result.code);
          setPhase("refused");
          return;
        }
        attempt.current = { operationId: result.operationId, phraseSession: result.phraseSession };
        setExpiresAt(result.expiresAt);
        setPhrase(result.words);
        setBackupConfirmed(false);
        setPhase("recovery");
      } catch {
        if (isCurrent(generation)) {
          setRefusal("setup_unavailable");
          setPhase("refused");
        }
      } finally {
        if (isCurrent(generation)) actionBusy.current = false;
      }
    },
  });
  const values = useStore(form.store, (state) => state.values);
  const modules = [...registry.modules.values()].map((spec) => ({
    id: spec.id,
    name: moduleName(spec, lang()),
    description: moduleDescription(spec, lang()),
    available: spec.available,
    dependsOn: spec.dependsOn.map((id) => moduleName(registry.modules.get(id) ?? spec, lang())),
    selected: values.modules.includes(spec.id),
  }));

  const complete = async (locator: NativeCreationReady, generation: number) => {
    if (!isCurrent(generation) || completed.current) return;
    if (options.workspace && !options.workspace.isCurrent(locator)) {
      setPhase("workspace_unknown");
      return;
    }
    completed.current = true;
    try {
      await options.onComplete?.(locator);
      if (isCurrent(generation)) setPhase("ready");
    } catch {
      completed.current = false;
      if (isCurrent(generation)) setPhase("workspace_unknown");
    }
  };

  const inspectWorkspace = async (locator: NativeCreationReady, generation: number) => {
    if (!isCurrent(generation)) return;
    setPhase("workspace_checking");
    setWorkspaceInspected(false);
    const port = options.workspace;
    if (!port?.isCurrent(locator)) {
      setWorkspaceStatus({ availability: "unavailable", reason: "source_unbound" });
      setPhase("workspace_unavailable");
      return;
    }
    try {
      const status = await port.inspect(locator);
      if (!isCurrent(generation) || !port.isCurrent(locator)) return;
      setWorkspaceStatus(status);
      setWorkspaceInspected(true);
      if (status.availability === "ready") {
        if (!workspacePathDirty) setWorkspacePath(status.path || status.defaultPath);
        const target = attemptedWorkspace.current;
        if (target) {
          if (workspaceMatches(status, target)) await complete(locator, generation);
          else setPhase("workspace_unknown");
        } else setPhase("workspace_ready");
      } else setPhase("workspace_unavailable");
    } catch {
      if (isCurrent(generation) && port.isCurrent(locator)) {
        setWorkspaceStatus({ availability: "unavailable", reason: "inspect_failed" });
        setPhase("workspace_unavailable");
      }
    }
  };

  const acceptReady = async (locator: NativeCreationReady, generation: number) => {
    if (!isCurrent(generation)) return;
    setPhase("verifying");
    try {
      const accepted = await options.onReady(locator);
      if (!isCurrent(generation)) return;
      if (!accepted) {
        setPhase("unknown");
        return;
      }
      verified.current = locator;
      if (!workspaceEnabled) await complete(locator, generation);
      else await inspectWorkspace(locator, generation);
    } catch {
      if (isCurrent(generation)) setPhase("unknown");
    }
  };

  const reverifyWorkspaceOwner = async (locator: NativeCreationReady, generation: number) => {
    if (!isCurrent(generation)) return false;
    if (phase !== "workspace_unknown") return true;
    try {
      const accepted = await options.onReady(locator);
      if (!isCurrent(generation) || !accepted) {
        if (isCurrent(generation)) setPhase("workspace_unknown");
        return false;
      }
      verified.current = locator;
      return true;
    } catch {
      if (isCurrent(generation)) setPhase("workspace_unknown");
      return false;
    }
  };

  const reflect = async (
    result: Awaited<ReturnType<CreationBridge["current"]>>,
    generation: number,
  ) => {
    if (!isCurrent(generation)) return;
    if (result.kind === "pending" || result.kind === "outcome_unknown") {
      attempt.current = { operationId: result.operationId, phraseSession: null };
      setStage(result.stage);
      setPhase(result.kind === "pending" ? "pending" : "unknown");
    } else if (result.kind === "ready" && options.mode === "first") {
      attempt.current = { operationId: result.operationId, phraseSession: null };
      await acceptReady(result, generation);
    } else setPhase("profile");
  };
  const reflectEvent = useEffectEvent(reflect);

  useEffect(() => {
    const generation = ++lifetime.current;
    const lifetimeRef = lifetime;
    const attemptRef = attempt;
    verified.current = null;
    attemptedWorkspace.current = null;
    completed.current = false;
    actionBusy.current = false;
    const bridge = options.bridge;
    // Bridge replacement invalidates in-flight display state without discarding a durable ID.
    queueMicrotask(() => {
      if (!isCurrent(generation)) return;
      setPhrase("");
      setExpiresAt("");
      setBackupConfirmed(false);
      setPhase(bridge ? "checking" : "unavailable");
    });
    if (!bridge)
      return () => {
        if (lifetimeRef.current === generation) lifetimeRef.current++;
      };
    else {
      const operationId = attempt.current?.operationId;
      if (operationId) attempt.current = { operationId, phraseSession: null };
      const pending = operationId
        ? bridge.inspect({ operationId }).then(async (status) => {
            if (!isCurrent(generation)) return;
            if (status.kind === "not_found") {
              const current = await bridge.current();
              if (!isCurrent(generation)) return;
              if (
                current.kind === "none" ||
                (current.kind === "ready" && current.operationId !== operationId)
              )
                setPhase("restart_possible");
              else await reflectEvent(current, generation);
            } else await reflectEvent(status, generation);
          })
        : bridge.current().then((status) => reflectEvent(status, generation));
      void pending.catch(() => {
        if (isCurrent(generation)) setPhase("unavailable");
      });
    }
    return () => {
      if (lifetimeRef.current === generation) lifetimeRef.current++;
      if (attemptRef.current?.phraseSession) attemptRef.current = null;
    };
  }, [options.bridge, options.mode]);

  useEffect(() => {
    if (phase !== "recovery" || !expiresAt) return;
    const generation = lifetime.current;
    const expire = () => {
      if (!isCurrent(generation)) return;
      setPhrase("");
      attempt.current = null;
      setRefusal("prepare_expired");
      setPhase("refused");
    };
    const remaining = Date.parse(expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      queueMicrotask(expire);
      return;
    }
    // A wall-clock rollback cannot keep the one-time phrase visible past this local window.
    const timer = setTimeout(expire, Math.min(remaining, 600_000));
    return () => clearTimeout(timer);
  }, [phase, expiresAt]);

  const checkStatus = async () => {
    if (!options.bridge || actionBusy.current) return;
    actionBusy.current = true;
    const generation = lifetime.current;
    setCheckingStatus(true);
    try {
      const operationId = attempt.current?.operationId;
      const inspected = operationId ? await options.bridge.inspect({ operationId }) : null;
      if (!isCurrent(generation)) return;
      if (inspected?.kind === "ready") {
        await acceptReady(inspected, generation);
        return;
      }
      if (inspected?.kind === "pending" || inspected?.kind === "outcome_unknown") {
        setStage(inspected.stage);
        setPhase(inspected.kind === "pending" ? "pending" : "unknown");
        return;
      }
      const current = await options.bridge.current();
      if (!isCurrent(generation)) return;
      if (
        !operationId &&
        (current.kind === "none" || (current.kind === "ready" && options.mode === "additional"))
      )
        setPhase("profile");
      else if (
        inspected?.kind === "not_found" &&
        (current.kind === "none" ||
          (current.kind === "ready" && current.operationId !== operationId))
      )
        setPhase("restart_possible");
      else if (current.kind === "pending" || current.kind === "outcome_unknown") {
        attempt.current = { operationId: current.operationId, phraseSession: null };
        setStage(current.stage);
        setPhase(current.kind === "pending" ? "pending" : "unknown");
      } else if (current.kind === "ready" && current.operationId === operationId)
        await acceptReady(current, generation);
      else setPhase("unknown");
    } catch {
      if (isCurrent(generation)) setPhase("unknown");
    } finally {
      if (isCurrent(generation)) {
        actionBusy.current = false;
        setCheckingStatus(false);
      }
    }
  };

  const commit = async () => {
    const bridge = options.bridge;
    const prepared = attempt.current;
    if (!bridge || !prepared?.phraseSession || !backupConfirmed || actionBusy.current) return;
    actionBusy.current = true;
    const generation = lifetime.current;
    setPhrase("");
    setExpiresAt("");
    attempt.current = { operationId: prepared.operationId, phraseSession: null };
    setPhase("committing");
    try {
      const result = await bridge.commit({
        operationId: prepared.operationId,
        phraseSession: prepared.phraseSession,
      });
      if (!isCurrent(generation)) return;
      if (result.kind === "ready") await acceptReady(result, generation);
      else if (result.kind === "outcome_unknown") {
        setStage(result.stage);
        setPhase("unknown");
      } else {
        setRefusal(result.code);
        setPhase("unknown");
      }
    } catch {
      if (isCurrent(generation)) setPhase("unknown");
    } finally {
      if (isCurrent(generation)) actionBusy.current = false;
    }
  };

  const applyWorkspace = async () => {
    const locator = verified.current;
    const port = options.workspace;
    if (!locator || !port?.isCurrent(locator) || actionBusy.current || !workspaceInspected) return;
    if (workspaceStatus?.availability !== "ready") return;
    actionBusy.current = true;
    const generation = lifetime.current;
    const target: WorkspaceTarget = {
      path: workspacePath.trim() || workspaceStatus.defaultPath,
      routinePermissions: values.modules.includes("investments") ? routinePermissions : false,
    };
    attemptedWorkspace.current = target;
    setPhase("workspace_applying");
    setWorkspaceError(null);
    try {
      const result = await port.apply(locator, target);
      if (!isCurrent(generation) || !port.isCurrent(locator)) return;
      if (result.kind === "completed" && workspaceMatches(result.status, target)) {
        setWorkspaceStatus(result.status);
        await complete(locator, generation);
        return;
      }
      setWorkspaceError(result.kind === "completed" ? "not_configured" : result.code);
      // A write can have happened even when its reply was lost. Inspect before offering Retry.
      setWorkspaceInspected(false);
      const uncertain = result.kind !== "refused";
      setPhase(uncertain ? "workspace_unknown" : "workspace_failed");
      if (uncertain) {
        const status = await port.inspect(locator);
        if (!isCurrent(generation) || !port.isCurrent(locator)) return;
        setWorkspaceStatus(status);
        setWorkspaceInspected(status.availability === "ready");
        if (workspaceMatches(status, target)) await complete(locator, generation);
      } else {
        attemptedWorkspace.current = null;
        setWorkspaceInspected(true);
      }
    } catch {
      if (isCurrent(generation) && port.isCurrent(locator)) {
        setWorkspaceError("outcome_unknown");
        setWorkspaceInspected(false);
        setPhase("workspace_unknown");
        try {
          const status = await port.inspect(locator);
          if (isCurrent(generation) && port.isCurrent(locator)) {
            setWorkspaceStatus(status);
            setWorkspaceInspected(status.availability === "ready");
            if (workspaceMatches(status, target)) await complete(locator, generation);
          }
        } catch {
          /* Keep unknown until a later read-only check. */
        }
      }
    } finally {
      if (isCurrent(generation)) actionBusy.current = false;
    }
  };

  return {
    phase,
    mode: options.mode,
    form,
    values,
    modules,
    phrase,
    expiresAt,
    backupConfirmed,
    stage,
    refusal,
    /** The profile step's name error (old `S.nameRequired`), shown under the field. */
    nameError,
    /** `2 moduły` of the modules step's counter. */
    pickedText: nModules(values.modules.length),
    checkingStatus,
    workspaceEnabled,
    workspacePath,
    routinePermissions,
    workspaceStatus,
    workspaceError,
    workspaceInspected,
    canClose: ["profile", "modules", "privacy", "recovery", "refused"].includes(phase),
    onClosed: options.onClosed
      ? () => {
          if (!["profile", "modules", "privacy", "recovery", "refused"].includes(phase)) return;
          lifetime.current++;
          setPhrase("");
          attempt.current = null;
          options.onClosed?.();
        }
      : undefined,
    onNameChanged: (name: string) => {
      setRefusal(null);
      setNameError(null);
      form.setFieldValue("name", name);
    },
    onCurrencyChanged: (currency: string) => {
      setRefusal(null);
      form.setFieldValue("baseCurrency", currency);
    },
    onDeviceAliasChanged: (alias: string) => {
      setRefusal(null);
      form.setFieldValue("deviceAlias", alias);
    },
    onModuleToggled: (id: string) => {
      setRefusal(null);
      form.setFieldValue("modules", toggleModuleSelection(registry, values.modules, id));
    },
    onPrivacyPicked: (choice: "strict" | "amounts") => {
      setRefusal(null);
      form.setFieldValue("mcpPrivacy", choice);
    },
    onWorkspaceEnabled: setWorkspaceEnabled,
    onWorkspacePathChanged: (path: string) => {
      setWorkspacePathDirty(true);
      setWorkspacePath(path);
    },
    onRoutinePermissionsChanged: setRoutinePermissions,
    onWorkspaceApply: applyWorkspace,
    onWorkspaceInspect: async () => {
      const locator = verified.current;
      const generation = lifetime.current;
      if (!locator || actionBusy.current) return;
      actionBusy.current = true;
      try {
        if (await reverifyWorkspaceOwner(locator, generation))
          await inspectWorkspace(locator, generation);
      } finally {
        if (isCurrent(generation)) actionBusy.current = false;
      }
    },
    onWorkspaceSkip: async () => {
      const locator = verified.current;
      const generation = lifetime.current;
      if (!locator || actionBusy.current) return;
      actionBusy.current = true;
      try {
        if (await reverifyWorkspaceOwner(locator, generation)) await complete(locator, generation);
      } finally {
        if (isCurrent(generation)) actionBusy.current = false;
      }
    },
    onNext: () => {
      if (phase === "profile" && !values.name.trim()) setNameError(Wizard.nameRequired);
      else if (phase === "profile" && values.name.trim().length <= 40) setPhase("modules");
      else if (phase === "modules") setPhase("privacy");
    },
    onBack: () => {
      if (phase === "modules") setPhase("profile");
      if (phase === "privacy") setPhase("modules");
    },
    onPrepare: () => form.handleSubmit(),
    onBackupConfirmed: setBackupConfirmed,
    onCommit: commit,
    onCheckStatus: checkStatus,
    onRestart: () => {
      if (phase !== "restart_possible") return;
      attempt.current = null;
      setStage(null);
      setRefusal(null);
      setPhase("profile");
    },
  };
}

export type CreationScreenState = ReturnType<typeof useCreationScreen>;
