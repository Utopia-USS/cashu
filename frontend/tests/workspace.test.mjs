// Agent workspace helpers (src/core/workspace.ts): labels and the status tag.
import assert from "node:assert/strict";
import { test } from "node:test";
import { changesToast, needsForce, outdatedLabel, workspaceErrorText, workspaceSummary } from "../src/core/workspace.ts";

const base = {
  path: "/tmp/ws/anna", default_path: "/tmp/ws/anna", configured: true, custom: false, exists: true,
  folder_exists: true, conflict: null, managed_version: "0.1.0", current_version: "0.1.0",
  updated_at: null, up_to_date: true, outdated: [], skills: [], skills_source: true,
  claude_command: "cd /tmp/ws/anna && claude",
  routine_command: "cd /tmp/ws/anna && claude -p '/market-research rutyna'", routine_permissions: false,
};

test("outdated items read as Polish one-liners", () => {
  assert.equal(outdatedLabel({ kind: "claude_md", name: "tools", reason: "outdated" }), "CLAUDE.md, sekcja narzędzia MCP: nieaktualne");
  assert.equal(outdatedLabel({ kind: "claude_md", name: "CLAUDE.md", reason: "missing" }), "CLAUDE.md: brak");
  assert.equal(outdatedLabel({ kind: "skill", name: "import-builder", reason: "modified" }), "skill /import-builder: zmienione lokalnie");
  assert.equal(outdatedLabel({ kind: "mcp", name: ".mcp.json", reason: "invalid" }), ".mcp.json (serwer MCP): nieczytelny plik");
  assert.equal(outdatedLabel({ kind: "folder", name: "inbox", reason: "missing" }), "folder inbox/: brak");
  assert.equal(outdatedLabel({ kind: "new_kind", name: "x", reason: "odd" }), "x: odd");
});

test("status tag: not created, current, fixable, only local edits, other profile", () => {
  assert.deepEqual(workspaceSummary(null), { tone: undefined, text: "nieznany" });
  assert.deepEqual(workspaceSummary({ ...base, exists: false, up_to_date: false }), { tone: undefined, text: "nie utworzono" });
  assert.deepEqual(workspaceSummary(base), { tone: "pos", text: "aktualny" });
  const outdated = [
    { kind: "skill", name: "a", reason: "outdated" },
    { kind: "skill", name: "b", reason: "modified" },
    { kind: "claude_md", name: "tools", reason: "outdated" },
  ];
  const st = { ...base, up_to_date: false, outdated };
  assert.deepEqual(workspaceSummary(st), { tone: "warn", text: "do aktualizacji · 2" });
  assert.equal(needsForce(st), true);
  const local = { ...base, up_to_date: false, outdated: [outdated[1]] };
  assert.deepEqual(workspaceSummary(local), { tone: "warn", text: "zmiany lokalne" });
  assert.equal(needsForce({ ...base, up_to_date: false, outdated: [outdated[0]] }), false);
  assert.equal(needsForce(null), false);
  assert.deepEqual(workspaceSummary({ ...base, exists: false, conflict: "other_profile" }), { tone: "neg", text: "folder innego profilu" });
});

test("toast after create / update", () => {
  assert.equal(changesToast({ ...base, changes: [], moved_from: null }, true), "Utworzono workspace");
  assert.equal(changesToast({ ...base, changes: [], moved_from: null }, false), "Workspace jest aktualny");
  const one = { kind: "skill", name: "a", action: "updated" };
  assert.equal(changesToast({ ...base, changes: [one, one], moved_from: null }, false), "Zaktualizowano workspace (2)");
});

test("API errors: Polish text for known codes, the message otherwise", () => {
  const err = (message, code) => Object.assign(new Error(message), { code });
  assert.equal(workspaceErrorText(err("the workspace path must be absolute", "path_relative")), "Podaj pełną ścieżkę folderu (od / albo od ~).");
  assert.equal(workspaceErrorText(err("this folder is the workspace of another profile", "workspace_taken")), "Ten folder jest (albo zawiera) workspace innego profilu.");
  assert.equal(workspaceErrorText(err("something else", "unknown_code")), "something else");
  assert.equal(workspaceErrorText(err("no code", null)), "no code");
});
