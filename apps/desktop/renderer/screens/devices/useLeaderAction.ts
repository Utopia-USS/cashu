import type { DeviceListResult } from "@cashu/host-protocol";
import { useConnection, useProfile } from "@cashu/store-react";
import { useToast } from "@cashu/ui";
import { useEffect, useRef, useState } from "react";
import { devicesBridge } from "../../devicesBridge.js";
import { T } from "./Devices.strings.js";
import { currentFetcher } from "./deviceRows.js";

type Ready = Extract<DeviceListResult, { kind: "ready" }>;
type Status = "idle" | "busy" | "completed" | "unknown" | "failed";

/**
 * Dialog F: which device fetches the bank data. One profile-scoped owner action; DevicesScreen remounts
 * this hook when the vault changes. The primary button prepares the change and commits it with the
 * confirmation the host prepared (the same two calls as before, without a typed confirmation).
 */
export function useLeaderAction(list: Ready | null) {
  const vault = useProfile();
  const connection = useConnection();
  const bridge = devicesBridge();
  const toast = useToast();
  const [scope, setScope] = useState({ vault, bridge, connection });
  const epoch = useRef(0);
  const [target, setTarget] = useState("");
  const [force, setForce] = useState(false);
  const [localStatus, setStatus] = useState<Status>("idle");
  const [localOperationId, setOperationId] = useState<string | null>(null);
  const [inspectedOperationId, setInspectedOperationId] = useState<string | null>(null);
  const [dismissedOperationId, setDismissed] = useState<string | null>(null);
  const scopeActive =
    scope.vault === vault && scope.bridge === bridge && scope.connection === connection;
  if (!scopeActive) {
    setScope({ vault, bridge, connection });
    setTarget("");
    setForce(false);
    setStatus("idle");
    setOperationId(null);
    setInspectedOperationId(null);
    setDismissed(null);
  }
  const activeList =
    scopeActive && (connection === "online" || connection === "recovered") ? list : null;

  useEffect(() => {
    const current = ++epoch.current;
    const ref = epoch;
    return () => {
      if (ref.current === current) ref.current++;
    };
  }, [bridge, connection, vault]);

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

  const targetName = activeList?.devices.find((device) => device.id === target)?.name ?? null;

  function done(): void {
    if (targetName !== null) toast(T.fetchDone(targetName), 4000);
    setTarget("");
    setForce(false);
  }

  async function confirm() {
    if (
      !scopeActive ||
      !bridge?.leaderPreview ||
      !bridge.leaderCommit ||
      !target ||
      blocked ||
      status === "busy"
    )
      return;
    const ticket = epoch.current;
    setStatus("busy");
    try {
      const prepared = await bridge.leaderPreview({ vault, leader: target, force });
      if (epoch.current !== ticket || devicesBridge() !== bridge) return;
      if (prepared.kind !== "prepared" || prepared.vault !== vault) {
        setStatus("failed");
        return;
      }
      setOperationId(prepared.operationId);
      if (Date.now() >= prepared.expiresAt) {
        setStatus("failed");
        return;
      }
      const result = await bridge.leaderCommit({
        vault,
        token: prepared.token,
        confirmationText: prepared.confirmationText,
      });
      if (epoch.current !== ticket || devicesBridge() !== bridge) return;
      setStatus(
        result.kind === "completed"
          ? "completed"
          : result.kind === "outcome_unknown"
            ? "unknown"
            : "failed",
      );
      if (result.kind === "completed") done();
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
      if (result.kind === "completed") {
        setInspectedOperationId(operationId);
        done();
      }
    } catch {
      if (epoch.current === ticket && devicesBridge() === bridge) setStatus("unknown");
    }
  }

  return {
    list: activeList,
    available: scopeActive && !!bridge?.leaderPreview,
    /** Dialog F: open for a target, or for an outcome still to check. */
    dialogOpen:
      (target !== "" && !!activeList) ||
      (status === "unknown" && (operationId === null || operationId !== dismissedOperationId)),
    target,
    targetName,
    /** Who fetches today and for how long it has been silent; null when no device is named. */
    current:
      activeList === null
        ? null
        : (() => {
            const fetcher = currentFetcher(activeList);
            return fetcher === null || fetcher.name === targetName ? null : fetcher;
          })(),
    force,
    setForce,
    status,
    operationId,
    blocked,
    open(device: string) {
      if (status === "busy") return;
      setTarget(device);
      setForce(false);
      setDismissed(null);
      if (status !== "unknown") setStatus("idle");
    },
    confirm,
    inspect,
    close() {
      if (status === "busy") return;
      if (status === "unknown") setDismissed(operationId);
      setTarget("");
      setForce(false);
      if (status !== "unknown") setStatus("idle");
    },
  };
}

export type LeaderActionState = ReturnType<typeof useLeaderAction>;
