import { useConnection, useProfile } from "@cashu/store-react";
import { isIncognito, onIncognitoChange } from "@cashu/ui-logic/core/incognito";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { devicesBridge } from "../../devicesBridge.js";

type ListResult = Awaited<ReturnType<NonNullable<ReturnType<typeof devicesBridge>>["list"]>>;
type Preview = Extract<
  Awaited<ReturnType<NonNullable<ReturnType<typeof devicesBridge>>["revokePreview"]>>,
  { kind: "prepared" }
>;

export function useDevicesScreen() {
  const vault = useProfile();
  const connection = useConnection();
  const privacy = useSyncExternalStore(onIncognitoChange, isIncognito);
  const bridge = devicesBridge();
  const [scope, setScope] = useState({ vault, bridge, connection, privacy });
  const scopeActive =
    scope.vault === vault &&
    scope.bridge === bridge &&
    scope.connection === connection &&
    scope.privacy === privacy;
  const [loadedList, setList] = useState<ListResult | null>(null);
  const [selectedTarget, setTarget] = useState("");
  const [selectedRecertify, setRecertify] = useState<string[]>([]);
  const [preparedPreview, setPreview] = useState<Preview | null>(null);
  const [acknowledgedWarning, setWarningAck] = useState(false);
  const [acknowledgedLocalStart, setLocalAck] = useState(false);
  const [enteredPhrase, setPhrase] = useState("");
  const [currentStatus, setStatus] = useState<"idle" | "busy" | "completed" | "unknown" | "failed">(
    "idle",
  );
  const [refusal, setRefusal] = useState<string | null>(null);
  const [currentOperationId, setOperationId] = useState<string | null>(null);
  // Reset scoped input during render, before the new vault or privacy state reaches the View.
  if (!scopeActive) {
    setScope({ vault, bridge, connection, privacy });
    setList(null);
    setTarget("");
    setRecertify([]);
    setPreview(null);
    setWarningAck(false);
    setLocalAck(false);
    setPhrase("");
    setStatus("idle");
    setRefusal(null);
    setOperationId(null);
  }
  const list =
    scopeActive && !privacy && (connection === "online" || connection === "recovered")
      ? loadedList
      : null;
  const target = scopeActive ? selectedTarget : "";
  const recertify = scopeActive ? selectedRecertify : [];
  const preview = scopeActive && !privacy ? preparedPreview : null;
  const warningAck = scopeActive && acknowledgedWarning;
  const localAck = scopeActive && acknowledgedLocalStart;
  const phrase = scopeActive && !privacy ? enteredPhrase : "";
  const status = scopeActive ? currentStatus : "idle";
  const operationId = scopeActive ? currentOperationId : null;
  const lifetime = useRef(0);
  const requestGeneration = useRef(0);
  const activeAttempt = useRef<{ vault: string; operationId: string } | null>(null);
  const committing = useRef(false);
  const previewRef = useRef<Preview | null>(null);

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    const epoch = ++lifetime.current;
    const lifetimeRef = lifetime;
    const requestGenerationRef = requestGeneration;
    requestGeneration.current++;
    if (activeAttempt.current?.vault !== vault) activeAttempt.current = null;
    const pendingAttempt = activeAttempt.current;
    if (bridge && !privacy && (connection === "online" || connection === "recovered"))
      void bridge
        .list({ vault })
        .then((result) => {
          if (lifetime.current !== epoch) return;
          setList(result);
          if (result.kind === "ready") {
            const latest =
              result.operations.find((operation) => operation.phase === "may_append") ??
              result.operations[0];
            if (latest) {
              activeAttempt.current =
                latest.phase === "may_append" ? { vault, operationId: latest.operationId } : null;
              setOperationId(latest.operationId);
              setStatus(latest.phase === "may_append" ? "unknown" : "completed");
            } else if (pendingAttempt) {
              setOperationId(pendingAttempt.operationId);
              setStatus("unknown");
            }
          }
        })
        .catch(() => {
          if (lifetime.current === epoch) setList(null);
        });
    return () => {
      lifetimeRef.current++;
      requestGenerationRef.current++;
      const pending = previewRef.current;
      if (pending && bridge && !committing.current)
        void bridge.revokeCancel({ vault, token: pending.token }).catch(() => {});
      setPhrase("");
    };
  }, [vault, bridge, connection, privacy]);

  useEffect(() => {
    if (!scopeActive || !preparedPreview) return;
    const remaining = preparedPreview.expiresAt - Date.now();
    const timer = setTimeout(
      () => {
        setPreview(null);
        setPhrase("");
        setStatus("failed");
      },
      Math.max(0, remaining),
    );
    return () => clearTimeout(timer);
  }, [scopeActive, preparedPreview]);

  async function review(): Promise<void> {
    if (
      !bridge ||
      !target ||
      status === "busy" ||
      list?.kind !== "ready" ||
      list.evidence.historyPending ||
      list.evidence.overflow ||
      list.evidence.authorityUncertain ||
      list.evidence.writeAdmission !== "ready" ||
      activeAttempt.current?.vault === vault ||
      list.operations.some((operation) => operation.phase === "may_append")
    )
      return;
    const epoch = lifetime.current;
    const request = ++requestGeneration.current;
    setStatus("busy");
    setRefusal(null);
    try {
      if (preview) await bridge.revokeCancel({ vault, token: preview.token }).catch(() => {});
      setPreview(null);
      setPhrase("");
      const result = await bridge.revokePreview({
        vault,
        targets: [target],
        recertify: [...recertify].sort(),
      });
      if (lifetime.current !== epoch || requestGeneration.current !== request) {
        if (result.kind === "prepared")
          void bridge.revokeCancel({ vault, token: result.token }).catch(() => {});
        return;
      }
      if (result.kind !== "prepared") {
        setRefusal(result.code);
        setStatus("failed");
        return;
      }
      setPreview(result);
      setOperationId(result.operationId);
      setWarningAck(false);
      setLocalAck(false);
      setStatus("idle");
    } catch {
      if (lifetime.current === epoch) setStatus("failed");
    }
  }

  async function commit(): Promise<void> {
    if (
      !bridge ||
      !preview ||
      !warningAck ||
      !phrase ||
      status === "busy" ||
      (preview.localStartConfirmationRequired && !localAck) ||
      selectionDirty
    )
      return;
    const epoch = lifetime.current;
    const words = phrase;
    activeAttempt.current = { vault, operationId: preview.operationId };
    committing.current = true;
    setPhrase("");
    setPreview(null);
    setStatus("busy");
    try {
      const result = await bridge.revokeCommit({
        vault,
        token: preview.token,
        warningAcknowledgement: "revoke_risk_acknowledged",
        ...(preview.localStartConfirmationRequired
          ? { localStartAcknowledgement: "local_target_stream_never_seen" as const }
          : {}),
        recoveryPhrase: words,
      });
      if (lifetime.current !== epoch) {
        if (
          (result.kind === "completed" || result.kind === "refused") &&
          activeAttempt.current?.vault === vault &&
          activeAttempt.current.operationId === preview.operationId
        )
          activeAttempt.current = null;
        return;
      }
      setPreview(null);
      setRefusal(result.kind === "refused" ? result.code : null);
      setStatus(
        result.kind === "completed"
          ? "completed"
          : result.kind === "outcome_unknown"
            ? "unknown"
            : "failed",
      );
      if (result.kind === "refused") activeAttempt.current = null;
      if (result.kind === "completed") {
        activeAttempt.current = null;
        void bridge.list({ vault }).then((next) => {
          if (lifetime.current === epoch) setList(next);
        });
      }
    } catch {
      if (lifetime.current === epoch) {
        setPreview(null);
        setStatus("unknown");
      }
    } finally {
      committing.current = false;
    }
  }

  async function inspect(): Promise<void> {
    if (!bridge || !operationId || status === "busy") return;
    const epoch = lifetime.current;
    setStatus("busy");
    try {
      const result = await bridge.revokeInspect({ vault, operationId });
      if (lifetime.current !== epoch) return;
      setStatus(
        result.kind === "completed"
          ? "completed"
          : result.kind === "outcome_unknown" || result.kind === "refused"
            ? "unknown"
            : "failed",
      );
      if (
        result.kind === "completed" ||
        result.kind === "not_found" ||
        result.kind === "not_started"
      )
        activeAttempt.current = null;
    } catch {
      if (lifetime.current === epoch) setStatus("unknown");
    }
  }

  async function cancel(): Promise<void> {
    requestGeneration.current++;
    const pending = preview;
    setPreview(null);
    setPhrase("");
    setWarningAck(false);
    setLocalAck(false);
    if (pending && bridge && !committing.current)
      await bridge.revokeCancel({ vault, token: pending.token }).catch(() => {});
    if (!committing.current) setStatus(activeAttempt.current ? "unknown" : "idle");
  }

  const selectedInPreview =
    preview?.affected
      .filter((device) => device.selected)
      .map((device) => device.device)
      .sort() ?? [];
  const selectionDirty =
    recertify.length !== selectedInPreview.length ||
    [...recertify].sort().some((device, index) => device !== selectedInPreview[index]);
  function toggleRecertify(device: string, selected: boolean): void {
    setRecertify((current) =>
      selected ? [...new Set([...current, device])].sort() : current.filter((id) => id !== device),
    );
    setPhrase("");
    setWarningAck(false);
    setLocalAck(false);
  }

  return {
    list,
    target,
    setTarget,
    preview,
    recertify,
    toggleRecertify,
    selectionDirty,
    refusal,
    warningAck,
    setWarningAck,
    localAck,
    setLocalAck,
    phrase,
    setPhrase,
    status,
    operationId,
    review,
    commit,
    inspect,
    cancel,
  };
}
export type DevicesScreenState = ReturnType<typeof useDevicesScreen>;
