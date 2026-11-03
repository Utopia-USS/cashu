import { updateAction, updateStatus } from "@cashu/store/device";
import { useQuery, useUiAction } from "@cashu/store-react";
import { useEffect, useRef, useState } from "react";

export function useUpdateNotice() {
  const [poll, setPoll] = useState(0);
  const status = useQuery(updateStatus, { poll });
  const action = useUiAction(updateAction);
  const actionRun = useRef(action.run);
  useEffect(() => {
    actionRun.current = action.run;
  }, [action.run]);
  const [closedVersion, setClosedVersion] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const app = status.availability === "ready" ? status.app : null;
  const manualCheck = status.availability === "ready" && status.manualCheck;
  useEffect(() => {
    const active =
      app?.stage === "checking" || app?.stage === "downloading" || app?.stage === "installing";
    const timer = setInterval(() => setPoll((n) => n + 1), active ? 1_000 : 600_000);
    return () => clearInterval(timer);
  }, [app?.stage]);
  useEffect(() => {
    if (app?.stage !== "up_to_date" || !manualCheck) return;
    const timer = setTimeout(() => {
      void actionRun.current({ action: "dismiss" }).then(() => setPoll((n) => n + 1));
    }, 4_000);
    return () => clearTimeout(timer);
  }, [app?.stage, manualCheck]);
  const act = async (
    choice: "check" | "install" | "skip" | "dismiss" | "auto",
    enabled?: boolean,
  ) => {
    if (pending.current || status.availability !== "ready") return false;
    pending.current = true;
    setBusy(true);
    try {
      const reply = await action.run({
        action: choice,
        ...(enabled === undefined ? {} : { enabled }),
      });
      setPoll((n) => n + 1);
      return reply.status === "completed" && reply.value.kind === "completed";
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return {
    status,
    busy: busy || action.isPending,
    closedVersion,
    onBranchClosed: (version: string) => setClosedVersion(version),
    onAction: act,
  };
}
export type UpdateNoticeState = ReturnType<typeof useUpdateNotice>;
