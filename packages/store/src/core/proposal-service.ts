import { type CommandEnv, type EventWriter, refuse, runCommand } from "../command.js";
import type { Store } from "../materialize.js";
import { approvePrepared, failApprovedProposal } from "./proposal-commands.js";
import type { PreparedEffect } from "./proposal-execution.js";

export interface ProposalLock {
  /** Nonblocking acquisition; a release function is returned on success. */
  tryAcquire(): (() => void) | null;
}

/** Separate from the shared daily lock: only one proposal applies per vault. */
export class ProposalApplyingLock {
  private readonly held = new Set<string>();

  tryAcquire(vault: string): (() => void) | null {
    if (this.held.has(vault)) return null;
    this.held.add(vault);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.held.delete(vault);
    };
  }
}

/** Private file authority; implementations retain before/after images for later reconciliation. */
export interface ApprovalPublication<R> {
  publish(approvalEid: string, effect: R): Promise<void>;
  restore(): Promise<void>;
  discard(): Promise<void>;
  /** Reconcile the current folded winner while both locks remain held. */
  reconcile?(): Promise<void>;
}

export interface ApprovalExecutionDeps {
  readonly store: Store;
  readonly writer: EventWriter;
  readonly env: CommandEnv;
  /** The same lock instance used by daily/price work, injected by the local host. */
  readonly dailyLock: ProposalLock;
  readonly applyingLock: ProposalApplyingLock;
  /** A short, synchronous store write queue step; it never spans publication awaits. */
  readonly runWrite: <T>(work: () => T) => Promise<T>;
  /** Genuine current vault and holder capabilities, rechecked across every await. */
  readonly isVaultCurrent: () => boolean;
  readonly isHolder: () => boolean;
}

export type ApprovalExecutionResult<R> =
  | { readonly status: "approved"; readonly approvalEid: string; readonly effect: R }
  | { readonly status: "refused"; readonly reason: string; readonly cleanupFailed: boolean }
  | { readonly status: "failed"; readonly approvalEid: string; readonly reason: "write_failed" }
  | {
      readonly status: "recovery_needed";
      readonly approvalEid: string;
      readonly reason:
        | "authority_lost"
        | "restore_failed"
        | "failure_event_refused"
        | "reconcile_failed";
    };

/** A prepared effect is recorded once, then any local file publication is completed outside SQL. */
export async function executePreparedApproval<R>(
  deps: ApprovalExecutionDeps,
  effect: PreparedEffect<R>,
  publication?: ApprovalPublication<R>,
): Promise<ApprovalExecutionResult<R>> {
  const refused = async (reason: string): Promise<ApprovalExecutionResult<R>> => {
    let cleanupFailed = false;
    try {
      await publication?.discard();
    } catch {
      cleanupFailed = true;
    }
    return { status: "refused", reason, cleanupFailed };
  };
  const applyingRelease = deps.applyingLock.tryAcquire(deps.store.vault);
  if (applyingRelease === null) return refused("busy");
  let dailyRelease: (() => void) | null;
  try {
    dailyRelease = deps.dailyLock.tryAcquire();
  } catch (error) {
    applyingRelease();
    throw error;
  }
  if (dailyRelease === null) {
    applyingRelease();
    return refused("busy");
  }
  const current = () => {
    try {
      return (
        deps.isVaultCurrent() &&
        (effect.kind === "strategy" || effect.kind === "custom_rule" || deps.isHolder())
      );
    } catch {
      return false;
    }
  };
  const reconcile = async (): Promise<boolean> => {
    if (!current()) return false;
    try {
      await publication?.reconcile?.();
      return true;
    } catch {
      return false;
    }
  };
  try {
    const outcome = await deps.runWrite(() =>
      current()
        ? runCommand(deps.store, deps.writer, approvePrepared(effect), {}, deps.env)
        : refuse("authority_lost"),
    );
    if (!outcome.ok) return refused(outcome.reason);
    const { approvalEid, effect: effectValue } = outcome.value;
    if (publication === undefined) return { status: "approved", approvalEid, effect: effectValue };
    try {
      if (!current()) throw new Error("authority lost before publication");
      await publication.publish(approvalEid, effectValue);
      if (!current()) throw new Error("authority lost after publication");
    } catch {
      if (!current()) {
        return {
          status: "recovery_needed",
          approvalEid: outcome.value.approvalEid,
          reason: "authority_lost",
        };
      }
      let restored = false;
      if (current()) {
        try {
          await publication.restore();
          restored = true;
        } catch {
          restored = false;
        }
      }
      let failedEvent = false;
      if (current()) {
        try {
          const failed = await deps.runWrite(() =>
            current()
              ? runCommand(
                  deps.store,
                  deps.writer,
                  failApprovedProposal,
                  {
                    proposalGid: effect.proposalGid,
                    approvalEid,
                    result: { error_code: "write_failed" },
                  },
                  deps.env,
                )
              : refuse("authority_lost"),
          );
          failedEvent = failed.ok;
        } catch {
          failedEvent = false;
        }
      }
      const reconciled = await reconcile();
      if (!restored) return { status: "recovery_needed", approvalEid, reason: "restore_failed" };
      if (!failedEvent)
        return {
          status: "recovery_needed",
          approvalEid,
          reason: current() ? "failure_event_refused" : "authority_lost",
        };
      if (!reconciled)
        return { status: "recovery_needed", approvalEid, reason: "reconcile_failed" };
      return { status: "failed", approvalEid, reason: "write_failed" };
    }
    if (!(await reconcile()))
      return { status: "recovery_needed", approvalEid, reason: "reconcile_failed" };
    return { status: "approved", approvalEid, effect: effectValue };
  } finally {
    try {
      dailyRelease();
    } finally {
      applyingRelease();
    }
  }
}
