import { builtinRegistry, moduleDescription, moduleName, slugify } from "@cashu/domain/core";
import type { NativeCreationReady } from "@cashu/host-protocol";
import { nativeCreationPrepareParamsSchema } from "@cashu/host-protocol";
import { lang } from "@cashu/i18n";
import { useForm, useStore } from "@tanstack/react-form";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { CreationBridge } from "../../creationBridge.js";
import { toggleModuleSelection } from "./selection.js";

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
  | "ready";

export interface CreationScreenOptions {
  readonly mode: "first" | "additional";
  readonly bridge: CreationBridge | null;
  readonly onReady: (locator: NativeCreationReady) => Promise<boolean>;
  readonly onClosed?: () => void;
}

export function useCreationScreen(options: CreationScreenOptions) {
  const [phase, setPhase] = useState<Phase>("checking");
  const [phrase, setPhrase] = useState("");
  const [expiresAt, setExpiresAt] = useState("");
  const [backupConfirmed, setBackupConfirmed] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [checkingStatus, setCheckingStatus] = useState(false);
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

  const acceptReady = async (locator: NativeCreationReady, generation: number) => {
    if (!isCurrent(generation)) return;
    setPhase("verifying");
    try {
      const accepted = await options.onReady(locator);
      if (isCurrent(generation)) setPhase(accepted ? "ready" : "unknown");
    } catch {
      if (isCurrent(generation)) setPhase("unknown");
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
    checkingStatus,
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
    onNext: () => {
      if (phase === "profile" && values.name.trim().length > 0 && values.name.trim().length <= 40)
        setPhase("modules");
      else if (phase === "modules") setPhase("privacy");
    },
    onBack: () => {
      if (phase === "modules") setPhase("profile");
      if (phase === "privacy") setPhase("modules");
    },
    onPrepare: () => void form.handleSubmit(),
    onBackupConfirmed: setBackupConfirmed,
    onCommit: () => void commit(),
    onCheckStatus: () => void checkStatus(),
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
