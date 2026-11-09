import { deviceListResultSchema } from "@cashu/host-protocol";
import { deviceListState } from "@cashu/store/core/desktop-settings";
import { useConnection, useProfile, useQuery } from "@cashu/store-react";
import { useEffect, useRef, useState } from "react";
import { devicesBridge } from "../../devicesBridge.js";

type Preview = Extract<
  Awaited<ReturnType<NonNullable<ReturnType<typeof devicesBridge>>["revokePreview"]>>,
  { kind: "prepared" }
>;

export function useDevicesScreen() {
  const vault = useProfile();
  const connection = useConnection();
  const bridge = devicesBridge();
  // The device list is a live host query, pushed again after every sync pass and device change.
  const live = useQuery(deviceListState, { privacy: false });
  const parsed = live.status === "ready" ? deviceListResultSchema.safeParse(live.list) : null;
  const [scope, setScope] = useState({ vault, bridge, connection });
  const scopeActive =
    scope.vault === vault && scope.bridge === bridge && scope.connection === connection;
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
  const [inspectedOperationId, setInspectedOperationId] = useState<string | null>(null);
  // Reset scoped input during render, before the new vault reaches the View.
  if (!scopeActive) {
    setScope({ vault, bridge, connection });
    setTarget("");
    setRecertify([]);
    setPreview(null);
    setWarningAck(false);
    setLocalAck(false);
    setPhrase("");
    setStatus("idle");
    setRefusal(null);
    setOperationId(null);
    setInspectedOperationId(null);
  }
  const list =
    scopeActive && (connection === "online" || connection === "recovered") && parsed?.success
      ? parsed.data
      : null;
  const target = scopeActive ? selectedTarget : "";
  const recertify = scopeActive ? selectedRecertify : [];
  const preview = scopeActive ? preparedPreview : null;
  const warningAck = scopeActive && acknowledgedWarning;
  const localAck = scopeActive && acknowledgedLocalStart;
  const phrase = scopeActive ? enteredPhrase : "";
  // A removal the host still records as possibly appended (also one started before a restart or in another
  // window) shows as unknown until it is inspected.
  const pendingOperation =
    list?.kind === "ready"
      ? list.operations.find(
          (operation) =>
            operation.phase === "may_append" && operation.operationId !== inspectedOperationId,
        )
      : undefined;
  const localStatus = scopeActive ? currentStatus : "idle";
  const status = pendingOperation && localStatus !== "busy" ? "unknown" : localStatus;
  const operationId = pendingOperation?.operationId ?? (scopeActive ? currentOperationId : null);
  const lifetime = useRef(0);
  const requestGeneration = useRef(0);
  const activeAttempt = useRef<{ vault: string; operationId: string } | null>(null);
  const committing = useRef(false);
  const previewRef = useRef<Preview | null>(null);

  useEffect(() => {
    previewRef.current = preview;
  }, [preview]);

  useEffect(() => {
    ++lifetime.current;
    const lifetimeRef = lifetime;
    const requestGenerationRef = requestGeneration;
    requestGeneration.current++;
    if (activeAttempt.current?.vault !== vault) activeAttempt.current = null;
    return () => {
      lifetimeRef.current++;
      requestGenerationRef.current++;
      const pending = previewRef.current;
      if (pending && bridge && !committing.current)
        void bridge.revokeCancel({ vault, token: pending.token }).catch(() => {});
      setPhrase("");
    };
  }, [vault, bridge, connection]);

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
      if (result.kind === "refused" || result.kind === "completed") activeAttempt.current = null;
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
    const inspected = operationId;
    setOperationId(inspected);
    setStatus("busy");
    try {
      const result = await bridge.revokeInspect({ vault, operationId: inspected });
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
      ) {
        activeAttempt.current = null;
        setInspectedOperationId(inspected);
      }
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
