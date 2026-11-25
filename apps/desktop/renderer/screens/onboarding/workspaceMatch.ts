import type { CreationWorkspaceStatus } from "./workspacePort.js";

export interface WorkspaceTarget {
  readonly path: string;
  readonly routinePermissions: boolean;
}

/** A status may prove the requested state, never the result of some other workspace operation. */
export function workspaceMatches(
  status: CreationWorkspaceStatus,
  target: WorkspaceTarget,
): boolean {
  return (
    status.availability === "ready" &&
    status.configured &&
    status.upToDate &&
    status.path === target.path &&
    status.routinePermissions === target.routinePermissions
  );
}
