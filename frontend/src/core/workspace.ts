// Agent workspace (GET/POST /api/p/{slug}/workspace, core/workspace on the server): shapes and pure
// helpers for the wizard and Settings > Agent AI. No transport here (see workspaceApi.ts), so
// `npm test` can import it without a DOM.

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
}

export interface WorkspaceResult extends WorkspaceStatus {
  changes: WorkspaceChange[];
  moved_from: string | null;
}

export interface WorkspaceDefault { root: string; slug: string | null; path: string | null }

const REASON: Record<string, string> = {
  missing: "brak",
  outdated: "nieaktualne",
  extra: "do usunięcia (moduł wyłączony)",
  modified: "zmienione lokalnie",
  conflict: "Twój folder o tej nazwie",
  invalid: "nieczytelny plik",
};

const SECTION: Record<string, string> = {
  profile: "profil",
  privacy: "prywatność",
  tools: "narzędzia MCP",
  boundaries: "granice",
  files: "foldery",
  skills: "skille",
  research: "research",
};

/** Polish one-liner for an outdated item, e.g. "CLAUDE.md, sekcja narzędzia MCP: nieaktualne". */
export function outdatedLabel(item: WorkspaceItem): string {
  const reason = REASON[item.reason] ?? item.reason;
  switch (item.kind) {
    case "claude_md":
      return item.name === "CLAUDE.md"
        ? `CLAUDE.md: ${reason}`
        : `CLAUDE.md, sekcja ${SECTION[item.name] ?? item.name}: ${reason}`;
    case "mcp":
      return `.mcp.json (serwer MCP): ${reason}`;
    case "settings":
      return `uprawnienia (.claude/settings.json): ${reason}`;
    case "skill":
      return `skill /${item.name}: ${reason}`;
    case "folder":
      return `folder ${item.name}/: ${reason}`;
    default:
      return `${item.name}: ${reason}`;
  }
}

/** Items only "Zastąp zmienione" fixes (the user's local edits are never replaced silently). */
export const needsForce = (st: WorkspaceStatus | null): boolean =>
  !!st && st.outdated.some((i) => i.reason === "modified" || i.reason === "conflict");

export type WorkspaceTone = "pos" | "warn" | "neg" | undefined;

/** Status tag of the workspace card. */
export function workspaceSummary(st: WorkspaceStatus | null): { tone: WorkspaceTone; text: string } {
  if (!st) return { tone: undefined, text: "nieznany" };
  if (st.conflict) return { tone: "neg", text: "folder innego profilu" };
  if (!st.exists) return { tone: undefined, text: "nie utworzono" };
  if (st.up_to_date) return { tone: "pos", text: "aktualny" };
  const fixable = st.outdated.filter((i) => i.reason !== "modified" && i.reason !== "conflict").length;
  if (!fixable) return { tone: "warn", text: "zmiany lokalne" };
  return { tone: "warn", text: `do aktualizacji · ${fixable}` };
}

/** Toast after a create / update. */
export function changesToast(res: WorkspaceResult, created: boolean): string {
  if (created) return "Utworzono workspace";
  return res.changes.length ? `Zaktualizowano workspace (${res.changes.length})` : "Workspace jest aktualny";
}

/** Copy of the opt-in routine permissions switch (wizard and Settings). */
export const ROUTINE_PERMISSIONS_LABEL = "Pozwól sobotniej rutynie wyszukiwać w sieci i zapisywać notatki bez pytania";
export const ROUTINE_PERMISSIONS_HINT =
  "Bez tego rutyna uruchomiona bez nadzoru zatrzyma się przy pierwszym pytaniu o zgodę; z tym Claude w tym folderze przeszukuje sieć i zapisuje pliki w research/ i notes/ bez pytania (dane finansowe nadal tylko przez MCP).";

const ERRORS: Record<string, string> = {
  path_required: "Podaj folder.",
  path_relative: "Podaj pełną ścieżkę folderu (od / albo od ~).",
  path_is_file: "Pod tą ścieżką jest plik, nie folder.",
  path_home: "Wybierz osobny folder, nie cały katalog domowy ani dysk.",
  path_hidden: "Folder nie może leżeć w ukrytym katalogu (narzędzia importu nie czytają plików z ukrytych katalogów).",
  path_data_dir: "Workspace musi leżeć poza katalogiem danych finanse i nie może go zawierać.",
  path_checkout: "Workspace nie może leżeć w katalogu z kodem finanse.",
  workspace_taken: "Ten folder jest (albo zawiera) workspace innego profilu.",
  translocated: "Aplikacja działa z tymczasowej lokalizacji macOS: przenieś Finanse.app do folderu Programy i otwórz ją ponownie.",
  busy: "Workspace jest właśnie aktualizowany. Spróbuj za chwilę.",
  write_failed: "Nie udało się zapisać plików w tym folderze (uprawnienia albo dysk).",
};

/** Polish text of a workspace API error (the `X-Finanse-Error-Code` code on ApiError), else the
 * server's English message. */
export function workspaceErrorText(e: unknown): string {
  const code = (e as { code?: string | null } | null)?.code;
  if (code && ERRORS[code]) return ERRORS[code];
  return e instanceof Error ? e.message : String(e);
}
