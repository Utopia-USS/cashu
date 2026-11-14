// Pure helpers of the ported Settings page (ab24ab6 core/workspace.ts outdatedLabel / needsForce /
// workspaceSummary, Settings.tsx presence / job rows), on the native workspace and worker shapes.
import { REASON, WS, SECTION as WS_SECTION } from "@cashu/i18n/core/workspace.strings";
import type { TagTone } from "@cashu/ui";
import { proposalSummary } from "@cashu/ui-logic/core/messages";
import type { SettingsScreenState } from "./useSettingsScreen.js";

type Workspace = SettingsScreenState["workspace"];
type ProposalRow = SettingsScreenState["proposals"][number];
type WorkspaceItem = NonNullable<Workspace["outdated"]>[number];

const reasons: Record<string, string> = REASON;
const sections: Record<string, string> = WS_SECTION;

/** One-liner for an outdated item, e.g. "CLAUDE.md, sekcja narzędzia MCP: nieaktualne". */
export function outdatedLabel(item: WorkspaceItem): string {
  const reason = reasons[item.reason] ?? item.reason;
  switch (item.kind) {
    case "claude_md":
      return item.name === "CLAUDE.md"
        ? `CLAUDE.md: ${reason}`
        : WS.claudeMdSection(sections[item.name] ?? item.name, reason);
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
export const needsForce = (ws: Workspace): boolean =>
  (ws.outdated ?? []).some(
    (item) => item.kind !== "link" && (item.reason === "modified" || item.reason === "conflict"),
  );

const notFixable = (item: WorkspaceItem): boolean =>
  item.reason === "modified" || item.reason === "conflict" || item.reason === "unsupported";

/** Status tag of the workspace panel. */
export function workspaceSummary(ws: Workspace): { tone: TagTone; text: string } {
  if (ws.availability !== "ready") return { tone: "neutral", text: WS.unknown };
  if (ws.conflict) return { tone: "negative", text: WS.otherProfile };
  if (!ws.exists) return { tone: "neutral", text: WS.notCreated };
  if (ws.upToDate) return { tone: "positive", text: WS.upToDate };
  const fixable = (ws.outdated ?? []).filter((item) => !notFixable(item)).length;
  if (!fixable) return { tone: "warning", text: WS.localChanges };
  return { tone: "warning", text: WS.toUpdate(fixable) };
}

/** Old two-letter tones of the Settings catalogs (`OUTCOME`, `JOB_STATUS`) as Tag tones. */
export const tagTone = (tone: string | undefined): TagTone =>
  tone === "pos"
    ? "positive"
    : tone === "neg"
      ? "negative"
      : tone === "warn"
        ? "warning"
        : "neutral";

/** A pending proposal's line: the localized summary from its code and values, else the English summary. */
export function proposalTitle(row: ProposalRow): string {
  return (
    proposalSummary({
      kind: row.kind,
      summary: row.summary,
      summary_code: row.summaryCode,
      summary_params: row.summaryParams,
    }) ?? ""
  );
}
