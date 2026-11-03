/** Host-owned workspace capability. A binding belongs to one canonical open vault. */
export interface WorkspaceInspectInput {
  readonly slug: string;
  readonly modules: readonly { readonly id: string; readonly name: string }[];
  readonly privacy: "strict" | "amounts";
  readonly baseCurrency: string;
  readonly path?: string;
}

export interface WorkspaceApplyInput extends WorkspaceInspectInput {
  readonly force?: boolean;
  readonly routinePermissions?: boolean;
  /** Host session/vault/profile-context guard, checked before every effect and final success. */
  readonly isCurrent?: () => boolean;
}

interface WorkspaceOutdatedItem {
  readonly kind: "folder" | "claude_md" | "mcp" | "settings" | "skill" | "link" | "manifest";
  readonly name: string;
  readonly reason: string;
}

interface WorkspaceSkillStatus {
  readonly name: string;
  readonly module: string | null;
  readonly version: string;
  readonly state: "missing" | "ok" | "outdated" | "modified" | "conflict" | "extra";
}

export type WorkspaceStatus =
  | { readonly availability: "unavailable"; readonly reason: string }
  | {
      readonly availability: "ready";
      readonly path: string;
      readonly defaultPath: string;
      readonly configured: boolean;
      readonly custom: boolean;
      readonly exists: boolean;
      readonly folderExists: boolean;
      readonly conflict: string | null;
      readonly managedVersion: string | null;
      readonly currentVersion: string;
      readonly updatedAt: string | null;
      readonly upToDate: boolean;
      readonly mcpCommandStale: boolean;
      readonly outdated: readonly WorkspaceOutdatedItem[];
      readonly skills: readonly WorkspaceSkillStatus[];
      readonly skillsSource: boolean;
      readonly claudeCommand: string | null;
      readonly routineCommand: string | null;
      readonly routinePermissions: boolean;
    };

export interface WorkspaceChange {
  readonly kind: string;
  readonly name: string;
  readonly action: string;
}

export type WorkspaceApplyResult =
  | {
      readonly kind: "completed";
      readonly status: WorkspaceStatus;
      readonly changes: readonly WorkspaceChange[];
      readonly movedFrom: string | null;
    }
  | { readonly kind: "refused"; readonly code: string; readonly status?: WorkspaceStatus }
  | {
      readonly kind: "partial" | "outcome_unknown";
      readonly code: string;
      readonly changes: readonly WorkspaceChange[];
      readonly status?: WorkspaceStatus;
    };

export interface WorkspaceBinding {
  readonly generation: string;
  isCurrent(): boolean;
  inspect(input: WorkspaceInspectInput): Promise<WorkspaceStatus>;
  apply(input: WorkspaceApplyInput): Promise<WorkspaceApplyResult>;
}

export interface WorkspaceProvider {
  bind(vault: string): WorkspaceBinding | null;
}
