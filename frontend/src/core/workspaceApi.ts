// Transport for the agent workspace endpoints (shapes and helpers: workspace.ts).
import { j, jpost, pp } from "./api";
import type { WorkspaceDefault, WorkspaceResult, WorkspaceStatus } from "./workspace";

export const getWorkspace = (slug: string) => j<WorkspaceStatus>(pp(slug, "/workspace"));

/** Create or update; `path` also moves the workspace there, `force` replaces locally edited skills
 * (the server keeps a backup), `routine_permissions` switches the opt-in rules of the unattended
 * research routine (omitted = keep). */
export const postWorkspace = (
  slug: string,
  body: { path?: string | null; force?: boolean; routine_permissions?: boolean } = {},
) => jpost<WorkspaceResult>(pp(slug, "/workspace"), body);

/** Default folder of a profile about to be created (the wizard's path field). */
export const getWorkspaceDefault = (name: string) =>
  j<WorkspaceDefault>(`/api/workspaces/default?name=${encodeURIComponent(name)}`);
