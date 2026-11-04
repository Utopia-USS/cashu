import type { DeviceListResult, LeaderPreviewResult } from "@cashu/host-protocol";
import { useConnection, useProfile } from "@cashu/store-react";
import { isIncognito, onIncognitoChange } from "@cashu/ui-logic/core/incognito";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { devicesBridge } from "../../devicesBridge.js";

type Ready = Extract<DeviceListResult, { kind: "ready" }>;
type Prepared = Extract<LeaderPreviewResult, { kind: "prepared" }>;
type Status = "idle" | "busy" | "completed" | "unknown" | "failed";

/** One profile-scoped owner action. DevicesScreen remounts this hook when the vault changes. */
export function useLeaderAction(list: Ready | null) {
  const vault = useProfile();
  const connection = useConnection();
  const privacy = useSyncExternalStore(onIncognitoChange, isIncognito);
  const bridge = devicesBridge();
  const [scope, setScope] = useState({ vault, bridge, connection, privacy });
  const epoch = useRef(0);
  const [target, setTarget] = useState("");
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState<Prepared | null>(null);
  const [typed, setTyped] = useState("");
  const [localStatus, setStatus] = useState<Status>("idle");
  const [localOperationId, setOperationId] = useState<string | null>(null);
  const [inspectedOperationId, setInspectedOperationId] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const scopeActive =
    scope.vault === vault &&
    scope.bridge === bridge &&
    scope.connection === connection &&
    scope.privacy === privacy;
  if (!scopeActive) {
    setScope({ vault, bridge, connection, privacy });
    setTarget("");
    setForce(false);
    setPreview(null);
    setTyped("");
    setStatus("idle");
    setOperationId(null);
    setInspectedOperationId(null);
    setExpired(false);
  }
  const activeList =
    scopeActive && !privacy && (connection === "online" || connection === "recovered")
      ? list
      : null;

  useEffect(() => {
    const current = ++epoch.current;
    const ref = epoch;
    return () => {
      if (ref.current === current) ref.current++;
    };
  }, [bridge, connection, privacy, vault]);

  useEffect(() => {
    if (!preview) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, preview.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [preview]);

  const pending = activeList?.leaderOperations?.find(
    (row) => row.phase === "may_append" && row.operationId !== inspectedOperationId,
  );
  const operationId = pending?.operationId ?? localOperationId;
  const status: Status = pending && localStatus !== "busy" ? "unknown" : localStatus;
  const blocked =
    !activeList ||
    activeList.evidence.historyPending ||
    activeList.evidence.overflow ||
    activeList.evidence.authorityUncertain ||
    activeList.evidence.writeAdmission !== "ready" ||
    activeList.operations.some((row) => row.phase === "may_append") ||
    (activeList.leaderOperations ?? []).some((row) => row.phase === "may_append");

  async function review() {
    if (!scopeActive || !bridge?.leaderPreview || !target || blocked || status === "busy") return;
    const ticket = epoch.current;
    setStatus("busy");
    setPreview(null);
    setTyped("");
    setExpired(false);
    try {
      const result = await bridge.leaderPreview({ vault, leader: target, force });
      if (epoch.current !== ticket || devicesBridge() !== bridge) return;
      if (result.kind === "prepared" && result.vault === vault) {
        setPreview(result);
        setOperationId(result.operationId);
        setStatus("idle");
      } else setStatus("failed");
    } catch {
      if (epoch.current === ticket && devicesBridge() === bridge) setStatus("failed");
    }
  }

  async function commit() {
    if (
      !bridge?.leaderCommit ||
      !scopeActive ||
      !preview ||
      typed !== preview.confirmationText ||
      status === "busy" ||
      expired ||
      Date.now() >= preview.expiresAt
    )
      return;
    const ticket = epoch.current;
    const prepared = preview;
    setPreview(null);
    setTyped("");
    setStatus("busy");
    try {
      const result = await bridge.leaderCommit({
        vault,
        token: prepared.token,
        confirmationText: typed,
      });
      if (epoch.current !== ticket || devicesBridge() !== bridge) return;
      setStatus(
        result.kind === "completed"
          ? "completed"
          : result.kind === "outcome_unknown"
            ? "unknown"
            : "failed",
      );
    } catch {
      if (epoch.current === ticket && devicesBridge() === bridge) setStatus("unknown");
    }
  }

  async function inspect() {
    if (!scopeActive || !bridge?.leaderInspect || !operationId || status === "busy") return;
    const ticket = epoch.current;
    setStatus("busy");
    try {
      const result = await bridge.leaderInspect({ vault, operationId });
      if (epoch.current !== ticket || devicesBridge() !== bridge) return;
      setStatus(
        result.kind === "completed"
          ? "completed"
          : result.kind === "outcome_unknown" || result.kind === "refused"
            ? "unknown"
            : "failed",
      );
      if (result.kind === "completed") setInspectedOperationId(operationId);
    } catch {
      if (epoch.current === ticket && devicesBridge() === bridge) setStatus("unknown");
    }
  }

  return {
    list: activeList,
    available: scopeActive && !!bridge?.leaderPreview,
    target,
    setTarget,
    force,
    setForce,
    preview,
    typed,
    setTyped,
    status,
    operationId,
    blocked,
    expired,
    review,
    commit,
    inspect,
    cancel: () => {
      setPreview(null);
      setTyped("");
    },
  };
}

export type LeaderActionState = ReturnType<typeof useLeaderAction>;
