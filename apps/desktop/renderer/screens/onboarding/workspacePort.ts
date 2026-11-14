import type { NativeCreationReady } from "@cashu/host-protocol";

/** A coordinator supplied, exact-vault capability. The renderer never chooses a filesystem root. */
export type CreationWorkspaceStatus =
  | { readonly availability: "unavailable"; readonly reason: string }
  | {
      readonly availability: "ready";
      readonly path: string;
      readonly defaultPath: string;
      readonly configured: boolean;
      readonly upToDate: boolean;
      readonly routinePermissions: boolean;
    };

type CreationWorkspaceApply =
  | { readonly kind: "completed"; readonly status: CreationWorkspaceStatus }
  | { readonly kind: "refused"; readonly code: string; readonly status?: CreationWorkspaceStatus }
  | {
      readonly kind: "partial" | "outcome_unknown";
      readonly code: string;
      readonly status?: CreationWorkspaceStatus;
    };

export interface CreationWorkspacePort {
  /** Captures the Create source selection, owner privacy and verified target/session. The new
   * vault need not be selected yet; selection happens only after workspace completion or Skip.
   * An unavailable capability remains current so the owner can Skip. */
  isCurrent(locator: NativeCreationReady): boolean;
  inspect(locator: NativeCreationReady): Promise<CreationWorkspaceStatus>;
  apply(
    locator: NativeCreationReady,
    input: { readonly path?: string; readonly routinePermissions?: boolean },
  ): Promise<CreationWorkspaceApply>;
}
