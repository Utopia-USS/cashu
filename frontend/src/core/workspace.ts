// Agent workspace (GET/POST /api/p/{slug}/workspace, core/workspace on the server): shapes and pure
// helpers for the wizard and Settings > Agent AI. No transport here (see workspaceApi.ts), so
// `npm test` can import it without a DOM.
import { ERRORS as ERROR_TEXT, REASON as REASONS, SECTION as SECTIONS, WS } from "./workspace.strings.ts";

export interface WorkspaceItem { kind: string; name: string; reason: string }
export interface WorkspaceSkill { name: string; module: string | null; version: string; state: string }
export interface WorkspaceChange { kind: string; name: string; action: string }

export interface WorkspaceStatus {
  path: string;
  default_path: string;
  configured: boolean;
  custom: boolean;
  exists: boolean;
  folder_exists: boolean;
  conflict: string | null;
  managed_version: string | null;
  current_version: string;
  updated_at: string | null;
  up_to_date: boolean;
  outdated: WorkspaceItem[];
  skills: WorkspaceSkill[];
  skills_source: boolean;
  claude_command: string;
  /** `cd <path> && claude -p '/market-research rutyna'` (the LaunchAgent alternative). */
  routine_command: string;
  /** Opt-in: the unattended Saturday routine may search the web and write notes without asking. */
  routine_permissions: boolean;
  /** F7 OB7: the command recorded in .mcp.json is not this app's program (moved app); "Aktualizuj" rewrites it. */
  mcp_command_stale?: boolean;
}

export interface WorkspaceResult extends WorkspaceStatus {
  changes: WorkspaceChange[];
  moved_from: string | null;
}

export interface WorkspaceDefault { root: string; slug: string | null; path: string | null }

const REASON: Record<string, string> = REASONS;
const SECTION: Record<string, string> = SECTIONS;

/** One-liner for an outdated item, e.g. "CLAUDE.md, sekcja narzędzia MCP: nieaktualne". */
export function outdatedLabel(item: WorkspaceItem): string {
  const reason = REASON[item.reason] ?? item.reason;
  switch (item.kind) {
    case "claude_md":
      return item.name === "CLAUDE.md"
        ? `CLAUDE.md: ${reason}`
        : WS.claudeMdSection(SECTION[item.name] ?? item.name, reason);
    case "mcp":
      return WS.mcpJson(reason);
    case "settings":
      return WS.settingsJson(reason);
    case "skill":
      return `skill /${item.name}: ${reason}`;
    case "folder":
      return WS.folder(item.name, reason);
    case "link":
      return WS.codexLink(item.name, item.reason === "conflict" ? WS.ownFileConflict : reason);
    default:
      return `${item.name}: ${reason}`;
  }
}

/** Items only "Zastąp zmienione" fixes (the user's local edits are never replaced silently). */
export const needsForce = (st: WorkspaceStatus | null): boolean =>
  !!st && st.outdated.some((i) => i.kind !== "link" && (i.reason === "modified" || i.reason === "conflict"));

/** Items neither "Aktualizuj" nor "Zastąp zmienione" changes: local edits, the user's own file where a
 * Codex link belongs (merged by the workspace-setup skill), a link the system cannot create. */
const notFixable = (i: WorkspaceItem): boolean =>
  i.reason === "modified" || i.reason === "conflict" || i.reason === "unsupported";

export type WorkspaceTone = "pos" | "warn" | "neg" | undefined;

/** Status tag of the workspace card. */
export function workspaceSummary(st: WorkspaceStatus | null): { tone: WorkspaceTone; text: string } {
  if (!st) return { tone: undefined, text: WS.unknown };
  if (st.conflict) return { tone: "neg", text: WS.otherProfile };
  if (!st.exists) return { tone: undefined, text: WS.notCreated };
  if (st.up_to_date) return { tone: "pos", text: WS.upToDate };
  const fixable = st.outdated.filter((i) => !notFixable(i)).length;
  if (!fixable) return { tone: "warn", text: WS.localChanges };
  return { tone: "warn", text: WS.toUpdate(fixable) };
}

/** Toast after a create / update. */
export function changesToast(res: WorkspaceResult, created: boolean): string {
  if (created) return WS.created;
  return res.changes.length ? WS.updated(res.changes.length) : WS.alreadyUpToDate;
}

// The copy shared by the wizard, Settings and the setup page (routine permissions switch, proposal note,
// macOS App Translocation text) is `WS` in workspace.strings.ts.

const ERRORS: Record<string, string> = ERROR_TEXT;

/** Text of a workspace API error (the `X-Cashu-Error-Code` code on ApiError), else the
 * server's English message. */
export function workspaceErrorText(e: unknown): string {
  const code = (e as { code?: string | null } | null)?.code;
  if (code && ERRORS[code]) return ERRORS[code];
  return e instanceof Error ? e.message : String(e);
}
