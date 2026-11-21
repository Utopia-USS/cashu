import { type DeviceListResult, deviceListResultSchema } from "@cashu/host-protocol";
import { deviceListState } from "@cashu/store/core/desktop-settings";
import { profileIdentity } from "@cashu/store/core/profile";
import { useConnection, useProfile, useQuery } from "@cashu/store-react";
import { useToast } from "@cashu/ui";
import { useEffect, useRef, useState } from "react";
import { devicesBridge } from "../../devicesBridge.js";
import { T } from "./Devices.strings.js";

type ReadyList = Extract<DeviceListResult, { kind: "ready" }>;

type Preview = Extract<
  Awaited<ReturnType<NonNullable<ReturnType<typeof devicesBridge>>["revokePreview"]>>,
  { kind: "prepared" }
>;

export function useDevicesScreen() {
  const vault = useProfile();
  const connection = useConnection();
  const toast = useToast();
  const profile = useQuery(profileIdentity);
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
  /** An open outcome the owner closed the dialog on; it shows again on the next removal. */
  const [dismissedOperationId, setDismissed] = useState<string | null>(null);
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
    setDismissed(null);
  }
  const current =
    scopeActive && (connection === "online" || connection === "recovered") && parsed?.success
      ? parsed.data
      : null;
  // The last ready list of this profile. A host handover (after a pairing or a sync switch) drops the
  // connection or refuses the list for a moment; the screen keeps showing what it had (`stale`, its
  // actions disabled) instead of flashing "unavailable". Keyed by the profile only: the connection
  // changes during exactly that handover. The View reveals the message itself after 3 s (CSS delay).
  const ready = current?.kind === "ready" ? current : null;
  const [held, setHeld] = useState<{ vault: string; raw: unknown; list: ReadyList } | null>(null);
  const raw = live.status === "ready" ? live.list : undefined;
  if (ready !== null && (held?.vault !== vault || held.raw !== raw)) {
    setHeld({ vault, raw, list: ready });
  }
  const kept = held?.vault === vault ? held.list : null;
  const list = ready ?? kept ?? current;
  const stale = ready === null && kept !== null;
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
  /** The removal dialog already asked once with every affected device kept (they start ticked). */
  const keptByDefault = useRef(false);
  /** The device name of the removal in flight, for the toast once it completed. */
  const removing = useRef<string | null>(null);

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

  /** Why a removal cannot start now (shown inside the dialog), or null. */
  const blocked: "overflow" | "pending" | "writer" | null =
    list?.kind !== "ready"
      ? null
      : list.evidence.overflow
        ? "overflow"
        : list.evidence.historyPending || list.evidence.authorityUncertain
          ? "pending"
          : list.evidence.writeAdmission !== "ready"
            ? "writer"
            : null;

  async function review(
    chosen: string = target,
    keep: readonly string[] = recertify,
  ): Promise<void> {
    if (
      !bridge ||
      !chosen ||
      status === "busy" ||
      current?.kind !== "ready" ||
      current.evidence.historyPending ||
      current.evidence.overflow ||
      current.evidence.authorityUncertain ||
      current.evidence.writeAdmission !== "ready" ||
      activeAttempt.current?.vault === vault ||
      current.operations.some((operation) => operation.phase === "may_append")
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
        targets: [chosen],
        recertify: [...keep].sort(),
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
      // The devices the removed one added start ticked ("Keep them in the profile"): ask once more
      // with all of them kept. When that is refused (capacity), the first answer stays, unticked.
      if (!keptByDefault.current && keep.length === 0 && result.affected.length > 0) {
        keptByDefault.current = true;
        const all = result.affected.map((device) => device.device).sort();
        const again = await bridge.revokePreview({ vault, targets: [chosen], recertify: all });
        if (lifetime.current !== epoch || requestGeneration.current !== request) {
          void bridge.revokeCancel({ vault, token: result.token }).catch(() => {});
          if (again.kind === "prepared")
            void bridge.revokeCancel({ vault, token: again.token }).catch(() => {});
          return;
        }
        if (again.kind === "prepared") {
          void bridge.revokeCancel({ vault, token: result.token }).catch(() => {});
          setRecertify(all);
          setPreview(again);
          setOperationId(again.operationId);
          setWarningAck(false);
          setLocalAck(false);
          setStatus("idle");
          return;
        }
        setRefusal(again.code);
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
    removing.current = targetName;
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
      if (result.kind === "completed") done();
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
      if (result.kind === "completed") done();
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

  /** A removal finished: the toast says so and the dialog closes. */
  function done(): void {
    toast(removing.current === null ? T.removedUnnamed : T.removed(removing.current), 4000);
    removing.current = null;
    setTarget("");
    setRecertify([]);
  }

  /** "Remove from profile…" on a row (also the note of a device that removed its copy). */
  function openRemoval(device: string): void {
    if (stale || status === "busy" || preview || list?.kind !== "ready") return;
    if (!list.devices.some((row) => row.id === device && row.trusted && !row.revoked)) return;
    keptByDefault.current = false;
    setDismissed(null);
    setTarget(device);
    setRecertify([]);
    setRefusal(null);
    setStatus("idle");
    if (blocked === null) void review(device, []);
  }

  /** Cancel or close: the prepared removal is cancelled and the words dropped. */
  async function closeRemoval(): Promise<void> {
    if (status === "unknown") setDismissed(operationId);
    setTarget("");
    setRecertify([]);
    setRefusal(null);
    await cancel();
    if (!activeAttempt.current) setStatus("idle");
  }

  const targetDevice =
    list?.kind === "ready" ? list.devices.find((device) => device.id === target) : undefined;
  const targetName = targetDevice?.name ?? null;
  /** The one checkbox of the dialog: which fact it states. */
  const ackKind: "local_start" | "behind" | "plain" = preview?.localStartConfirmationRequired
    ? "local_start"
    : targetDevice?.behind
      ? "behind"
      : "plain";
  const ack = warningAck && (!preview?.localStartConfirmationRequired || localAck);
  function setAck(checked: boolean): void {
    setWarningAck(checked);
    setLocalAck(checked);
  }

  return {
    list,
    stale,
    profileName: profile?.name ?? null,
    /** The removal dialog: open for a device, or for an outcome still to check. */
    dialogOpen:
      target !== "" ||
      (status === "unknown" && (operationId === null || operationId !== dismissedOperationId)),
    target,
    targetName,
    blocked,
    openRemoval,
    closeRemoval,
    preview,
    recertify,
    toggleRecertify,
    selectionDirty,
    refusal,
    ackKind,
    ack,
    setAck,
    phrase,
    setPhrase,
    status,
    operationId,
    review: () => review(),
    commit,
    inspect,
  };
}
export type DevicesScreenState = ReturnType<typeof useDevicesScreen>;
