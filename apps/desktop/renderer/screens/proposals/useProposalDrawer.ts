import { proposalDetail, proposalReview } from "@cashu/store/core/desktop-proposals";
import { useQuery, useUiAction } from "@cashu/store-react";
import { useUiEnv } from "@cashu/ui";
import { proposalError } from "@cashu/ui-logic/core/messages";
import { useEffect, useRef, useState } from "react";
import { type Message, strategyRefusal } from "./proposalRefusals.js";

export function useProposalDrawer(
  gid: string,
  onOutcome?: (outcome: {
    proposalGid: string;
    status: string;
    version?: number;
    approvalEid?: string;
    recoveryReason?: string;
  }) => void,
) {
  const { privacy } = useUiEnv();
  const detail = useQuery(proposalDetail, { gid, privacy });
  const review = useUiAction(proposalReview);
  const pending = useRef(false);
  const lifetime = useRef(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  useEffect(() => {
    const guard = lifetime;
    return () => {
      guard.current++;
    };
  }, []);
  const act = async (decision: "approve" | "reject") => {
    if (detail?.status !== "pending" || pending.current) return;
    const token = lifetime.current;
    pending.current = true;
    setBusy(true);
    setMessage(null);
    try {
      const reply = await review.run({ gid, decision });
      if (token !== lifetime.current) return;
      if (reply.status === "outcome_unknown") {
        setMessage("unknown");
        return;
      }
      if (reply.status !== "completed") {
        setMessage(
          reply.reason === "capability_unavailable"
            ? "unavailableApproval"
            : reply.reason === "not_pending"
              ? "notPending"
              : reply.reason === "busy"
                ? "busy"
                : reply.reason === "authority_lost"
                  ? "authorityLost"
                  : strategyRefusal(reply.reason),
        );
        return;
      }
      const result = reply.value;
      if (result.status === "outcome_unknown") {
        setMessage("unknown");
        return;
      }
      if (result.status === "approved") {
        const effect = result.effect;
        const version =
          effect &&
          typeof effect === "object" &&
          "version" in effect &&
          typeof effect.version === "number"
            ? effect.version
            : undefined;
        onOutcome?.({
          proposalGid: gid,
          status: "approved",
          approvalEid: result.approvalEid,
          ...(version === undefined ? {} : { version }),
        });
      } else if (result.status === "rejected") {
        onOutcome?.({ proposalGid: gid, status: "rejected" });
      } else if (result.status === "recovery_needed") {
        setMessage(
          result.reason === "authority_lost"
            ? "recoveryAuthority"
            : result.reason === "restore_failed"
              ? "recoveryRestore"
              : result.reason === "failure_event_refused"
                ? "recoveryEvent"
                : "recoveryReconcile",
        );
        onOutcome?.({
          proposalGid: gid,
          status: "recovery_needed",
          approvalEid: result.approvalEid,
          recoveryReason: result.reason,
        });
      } else if (result.status === "failed") {
        setMessage("failed");
        onOutcome?.({ proposalGid: gid, status: "failed", approvalEid: result.approvalEid });
      } else {
        setMessage(
          result.cleanupFailed
            ? "cleanupFailed"
            : result.reason === "busy"
              ? "busy"
              : result.reason === "base_changed"
                ? "baseChanged"
                : result.reason === "authority_lost"
                  ? "authorityLost"
                  : result.reason === "not_pending"
                    ? "notPending"
                    : "refused",
        );
      }
    } finally {
      if (token === lifetime.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  return {
    detail,
    busy: busy || review.isPending,
    message,
    failure: proposalError(detail?.result)?.text ?? "",
    onApproved: () => void act("approve"),
    onRejected: () => void act("reject"),
  };
}
export type ProposalDrawerState = ReturnType<typeof useProposalDrawer>;
