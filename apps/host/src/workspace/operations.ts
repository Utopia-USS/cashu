import type { WorkspaceApplyResult, WorkspaceChange, WorkspaceStatus } from "./index.js";

/** Each effect publishes one file/folder through a host-granted checked capability. */
export interface WorkspaceStep {
  readonly kind: string;
  readonly name: string;
  readonly action: string;
  /** false means no mutation; a string overrides the receipt action (e.g. unsupported link). */
  effect(): Promise<unknown> | unknown;
}

export interface WorkspaceOperation {
  readonly current: () => boolean;
  readonly steps: readonly WorkspaceStep[];
  readonly inspect: () => Promise<WorkspaceStatus>;
  readonly movedFrom: string | null;
}

/** Never replays an effect. A failed publication returns the acknowledged prefix; the failed step
 * may have mutated and requires inspection before a user-initiated retry. */
export async function runWorkspaceOperation(
  operation: WorkspaceOperation,
): Promise<WorkspaceApplyResult> {
  if (!operation.current()) return { kind: "refused", code: "stale_capability" };
  const changes: WorkspaceChange[] = [];
  for (const step of operation.steps) {
    if (!operation.current()) {
      return changes.length
        ? { kind: "partial", code: "stale_capability", changes }
        : { kind: "refused", code: "stale_capability" };
    }
    try {
      const result = await step.effect();
      if (result !== false)
        changes.push({
          kind: step.kind,
          name: step.name,
          action: typeof result === "string" ? result : step.action,
        });
    } catch {
      let status: WorkspaceStatus | undefined;
      try {
        status = await operation.inspect();
      } catch {
        /* Inspection can fail after a filesystem fault. */
      }
      return { kind: "partial", code: "write_failed", changes, ...(status ? { status } : {}) };
    }
  }
  if (!operation.current()) return { kind: "outcome_unknown", code: "stale_capability", changes };
  try {
    return {
      kind: "completed",
      status: await operation.inspect(),
      changes,
      movedFrom: operation.movedFrom,
    };
  } catch {
    return { kind: "outcome_unknown", code: "inspect_failed", changes };
  }
}
