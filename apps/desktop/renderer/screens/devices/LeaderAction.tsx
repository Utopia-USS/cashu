import type { DeviceListResult, LeaderPreviewResult } from "@cashu/host-protocol";
import { useProfile } from "@cashu/store-react";
import { useEffect, useRef, useState } from "react";
import { devicesBridge } from "../../devicesBridge.js";
import { T } from "./Devices.strings.js";

type Ready = Extract<DeviceListResult, { kind: "ready" }>;
type Prepared = Extract<LeaderPreviewResult, { kind: "prepared" }>;
const control =
  "rounded-sm border border-border bg-surface px-3 py-2 focus-visible:outline-2 focus-visible:outline-accent";
const button =
  "rounded-sm border border-border px-3 py-2 hover:bg-surface-sunken disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent";

/** An owner preview pins one head and one session; reopening recovers the original attempt ID. */
export function LeaderAction({ list }: { list: Ready }) {
  const vault = useProfile();
  const bridge = devicesBridge();
  const epoch = useRef(0);
  const [target, setTarget] = useState("");
  const [force, setForce] = useState(false);
  const [preview, setPreview] = useState<Prepared | null>(null);
  const [typed, setTyped] = useState("");
  const [status, setStatus] = useState<"idle" | "busy" | "completed" | "unknown" | "failed">(
    "idle",
  );
  const [operationId, setOperationId] = useState<string | null>(null);

  useEffect(() => {
    const current = ++epoch.current;
    const pending = list.leaderOperations.find((row) => row.phase === "may_append");
    if (pending) {
      setOperationId(pending.operationId);
      setStatus("unknown");
    }
    return () => {
      if (epoch.current === current) epoch.current++;
    };
  }, [vault, bridge]);

  const blocked =
    list.evidence.historyPending ||
    list.evidence.overflow ||
    list.evidence.authorityUncertain ||
    list.evidence.writeAdmission !== "ready" ||
    list.operations.some((row) => row.phase === "may_append") ||
    list.leaderOperations.some((row) => row.phase === "may_append");
  async function review() {
    if (!bridge?.leaderPreview || !target || blocked || status === "busy") return;
    const ticket = epoch.current;
    setStatus("busy");
    setPreview(null);
    setTyped("");
    try {
      const result = await bridge.leaderPreview({ vault, leader: target, force });
      if (epoch.current !== ticket) return;
      if (result.kind === "prepared") {
        setPreview(result);
        setOperationId(result.operationId);
        setStatus("idle");
      } else setStatus("failed");
    } catch {
      if (epoch.current === ticket) setStatus("failed");
    }
  }
  async function commit() {
    if (
      !bridge?.leaderCommit ||
      !preview ||
      typed !== preview.confirmationText ||
      status === "busy" ||
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
      if (epoch.current !== ticket) return;
      setStatus(
        result.kind === "completed"
          ? "completed"
          : result.kind === "outcome_unknown"
            ? "unknown"
            : "failed",
      );
    } catch {
      if (epoch.current === ticket) setStatus("unknown");
    }
  }
  async function inspect() {
    if (!bridge?.leaderInspect || !operationId || status === "busy") return;
    const ticket = epoch.current;
    setStatus("busy");
    try {
      const result = await bridge.leaderInspect({ vault, operationId });
      if (epoch.current !== ticket) return;
      setStatus(
        result.kind === "completed"
          ? "completed"
          : result.kind === "outcome_unknown" || result.kind === "refused"
            ? "unknown"
            : "failed",
      );
    } catch {
      if (epoch.current === ticket) setStatus("unknown");
    }
  }
  if (!bridge?.leaderPreview) return null;
  return (
    <section className="grid gap-3" aria-label={T.repinTitle}>
      <h4>{T.repinTitle}</h4>
      <p>{T.repinHelp}</p>
      <label className="grid gap-1">
        <span>{T.repinTarget}</span>
        <select
          className={control}
          value={target}
          disabled={!!preview || status === "busy"}
          onChange={(event) => setTarget(event.target.value)}
        >
          <option value="">{T.repinTarget}</option>
          {list.devices
            .filter(
              (device) => device.trusted && !device.revoked && device.id !== list.leader.device,
            )
            .map((device) => (
              <option key={device.id} value={device.id}>
                {device.name}
              </option>
            ))}
        </select>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={force}
          disabled={!!preview || status === "busy"}
          onChange={(event) => setForce(event.target.checked)}
        />
        {T.repinForce}
      </label>
      {force && <p role="alert">{T.repinOverlap}</p>}
      {!preview && (
        <button
          className={button}
          type="button"
          disabled={!target || blocked || status === "busy" || status === "unknown"}
          onClick={() => void review()}
        >
          {T.repinReview}
        </button>
      )}
      {preview && (
        <div className="grid gap-2 rounded-lg border border-border bg-surface-raised p-4">
          <p role="alert">{preview.force ? T.repinOverlap : T.repinHandover}</p>
          {preview.mayStillRun && <p role="alert">{T.repinMayStillRun}</p>}
          <label className="grid gap-1">
            <span>{T.repinType(preview.confirmationText)}</span>
            <input
              className={control}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            <button
              className={button}
              type="button"
              disabled={typed !== preview.confirmationText || Date.now() >= preview.expiresAt}
              onClick={() => void commit()}
            >
              {T.repinCommit}
            </button>
            <button
              className={button}
              type="button"
              onClick={() => {
                setPreview(null);
                setTyped("");
              }}
            >
              {T.cancel}
            </button>
          </div>
        </div>
      )}
      {status === "completed" && <p role="status">{T.repinCompleted}</p>}
      {status === "failed" && <p role="alert">{T.failed}</p>}
      {status === "unknown" && <p role="alert">{T.unknown}</p>}
      {status === "unknown" && operationId && (
        <button className={button} type="button" onClick={() => void inspect()}>
          {T.inspect}
        </button>
      )}
    </section>
  );
}
