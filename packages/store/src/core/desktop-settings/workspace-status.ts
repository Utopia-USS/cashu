// Ustawienia > Agent AI: the profile's agent workspace (folder, managed files, skills, commands) as one live vault
// query. The host inspects the workspace asynchronously and inspects it again after a workspace write (also from
// the CLI), a change of the profile context it depends on (slug, base currency, MCP privacy, modules) and any change
// in the workspace folder on disk, so the panel never asks it to check again. The value is the host's
// workspace status; the renderer reads it defensively.
import { defineQuery } from "../../query.js";

export type WorkspaceStatusState =
  | { readonly status: "loading" }
  /** `checking`: a newer inspection is running; `workspace` is the last one until it lands. */
  | { readonly status: "ready"; readonly workspace: unknown; readonly checking: boolean };

/** The query the renderer names; a host without a workspace provider answers this unbound status. */
export const workspaceStatus = defineQuery({
  id: "core.settings.workspaceStatus",
  run(_read, _args: undefined): WorkspaceStatusState {
    return {
      status: "ready",
      workspace: { availability: "unavailable", reason: "source_unbound" },
      checking: false,
    };
  },
});
