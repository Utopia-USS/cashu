---
name: workspace-setup
description: >
  Use at the first session in a cashU agent workspace, before any module setup, or when the user
  wants to add, convert or fix their own Claude Code or Codex skills and instructions for this profile.
  Applicability - POSITIVE: the agent layout of this workspace (CLAUDE.md as the inventory, the
  AGENTS.md and .agents/skills links for Codex) and the user's own skills built in the same shape.
  Applicability - NEGATIVE: NOT module setup (budget-setup, investments-setup, assets-setup,
  loans-setup), importers (import-builder), portfolio rules (extension-builder) or research
  (market-research).
  Triggers: /workspace-setup, "skonfiguruj workspace", "jak działa ten folder", "własny skill",
  "dodaj skill", "napisz skill", "popraw mój skill", "przenieś moje instrukcje do skilla", "Codex",
  "AGENTS.md".
---

# workspace-setup: the agent layout and the user's own skills

You explain how this workspace is organised and why, check that the layout is intact, and build the
user's own skills in the same shape so they sit next to the skills cashU manages. Conversation in
Polish, files in English, regular hyphens only.

## Relationship to the workspace

| The workspace CLAUDE.md and MCP server own | This skill adds |
|---|---|
| privacy level, boundaries, the MCP tool list, where files go | why the layout helps (step 1) |
| the managed sections, the managed skills and their inventory, the Codex links (cashU writes them) | a check of the layout (step 2) |
| | the user's own skills in the same shape and their "Own skills" rows (steps 3-5) |

## Non-negotiable

- Never edit text between the `cashu:begin` / `cashu:end` markers, nor a managed skill (one listed
  in the CLAUDE.md "Skills" table): cashU rewrites them on "Aktualizuj workspace".
- `AGENTS.md` and `.agents/skills` are links, never copies. A missing link: Ustawienia > Agent AI >
  "Aktualizuj workspace" creates it. A user file or folder in their place is never moved by cashU
  (not even by "Zastąp zmienione"): merge it with the user (step 4). Do not create the links
  yourself.
- An own skill never holds personal or financial data (amounts, account numbers, IBANs, names):
  it fetches data through the MCP tools when it runs.
- An own skill keeps the workspace boundaries (CLAUDE.md "Boundaries") and cannot widen them: no
  reads of the cashU data places, no orders, no price predictions, no passwords or keys.
- Own skill names never reuse a managed skill's name (cashU would report a conflict).

## Problem -> reference mapping

| Task / question | Start with |
|---|---|
| First session, "co to za folder", "po co AGENTS.md" | step 1 |
| Is the layout intact, does Codex see the skills | step 2 |
| A new own skill | step 3 + [`references/skill-shape.md`](references/skill-shape.md) |
| An existing own skill, long own instructions, an edited managed skill | step 4 + [`references/skill-shape.md`](references/skill-shape.md) |

## Steps

### 1. Recommend the layout and say why (first session, about a minute)

Say it short, in Polish, in your own words, covering:

- **What.** The folder follows the utopia-ai-arch "layer" layout: `CLAUDE.md` is a short inventory
  that is always loaded (which skill applies, which does not, where a task goes); every skill states
  when it applies and when it does not; deep content sits in each skill's `references/` and is read
  only when needed.
- **Why: navigation.** The agent goes straight to the right skill instead of guessing from one long
  file: fewer wrong turns, less context spent, and the user sees at a glance what exists.
- **Why: Claude Code and Codex.** `AGENTS.md` is a link to `CLAUDE.md` and `.agents/skills` a link
  to `.claude/skills`, so Codex reads the same files. One copy, nothing drifts.
- **Why: own skills.** Skills the user adds in the same shape fit into the inventory, route like the
  managed ones and survive cashU updates (cashU never touches them).
- **Recommendation.** Keep the layout and build own skills with this skill. Optional for Claude Code
  users who build many skills: the `utopia-ai-arch` plugin has the full blueprint
  (`/plugin marketplace add https://github.com/Utopia-USS/utopia-flutter-skills`, then
  `/plugin install utopia-ai-arch@utopia-flutter-skills`, then `/utopia-ai-arch:layer`). It is
  written for app repositories; this skill carries what a workspace needs, and Codex users need
  nothing extra.

Then write `notes/workspace-setup.md`: the date, "layout explained", the user's answer (kept or
declined) and the list of own skills (step 2). The module setup skills skip step 1 once this file
exists. If the user came from a module setup, return there now.

### 2. Check the layout

1. Ask to run `ls -la AGENTS.md .agents/skills .claude/skills` (Bash asks the user). Expected:
   `AGENTS.md -> CLAUDE.md`, `.agents/skills -> ../.claude/skills`.
2. `CLAUDE.md` has the managed sections "Agent layout" and "Skills" (with "When to Invoke") and,
   outside the markers, an "Own skills" section.
3. Folders in `.claude/skills/` that are not in the "Skills" table are the user's own skills. Each
   needs the POSITIVE / NEGATIVE scope in its description and a row in "Own skills".
4. Report a short table (item, state, fix). Fixes: a missing link -> "Aktualizuj workspace"; the
   user's own file or folder where a link belongs -> step 4; "system nie pozwala utworzyć linku"
   (no symlink privilege, e.g. Windows without Developer Mode) -> tell the user Codex will not see
   this layout until links are allowed; no "Own skills" section -> step 5; an own skill without
   scope -> step 4.
5. Codex users: Codex reads `AGENTS.md` and the skills, but the cashU MCP server is configured for
   Claude Code in `.mcp.json`. Without it Codex sees no profile data. Give the user the
   `codex mcp add cashu-<slug> ...` line built from the `command`, `args` and `env` of the profile's
   server in `.mcp.json`, to run in their own terminal, and say plainly: it goes into the user-level
   Codex config, so that profile's server is visible in every Codex session (with two profiles,
   both are); and Codex does not apply `.claude/settings.json`, so the deny rules on the cashU data
   places hold in Codex only as the instructions in `CLAUDE.md`, not as enforcement.

### 3. Build a new own skill

1. Interview, 1-3 questions per message (question tool with options where it fits): the task in the
   user's words; when it applies (situations, phrases the user would say); when it must not (and
   which managed skill covers that instead); what it reads (MCP tools, files in `notes/`); what it
   writes (MCP write tools store proposals the owner approves; files go to `notes/`, `research/`,
   `scripts/`); what must be true before it says "done".
2. Write `.claude/skills/<name>/SKILL.md` in the shape of
   [`references/skill-shape.md`](references/skill-shape.md); long procedures go into the skill's own
   `references/`.
3. Read it back in Polish: when it fires, when it does not, what it writes.
4. Test the routing: take one phrase the user would say (it must match the POSITIVE scope or a
   trigger) and one it must not take (the NEGATIVE scope must name where that goes).
5. Step 5.

### 4. Convert existing instructions or skills

- The user's own `AGENTS.md` where the link belongs: with the user's OK, move its content into
  "Your own instructions" in `CLAUDE.md` (outside the markers), ask to move the file to
  `.claude/cashu-backup/manual/AGENTS.md` (Bash asks the user), then "Aktualizuj workspace" links it.
- The user's own `.agents/skills/` folder: move each skill into `.claude/skills/` (a name that
  clashes with a managed skill gets a new name), then the emptied folder away as above, then
  "Aktualizuj workspace".
- Long text in "Your own instructions" that explains how to do something becomes a skill (step 3);
  the instructions keep a one-line route to it.
- An own skill without a scope or a References table gets them; all its content stays.
- A managed skill the user edited (Ustawienia > Agent AI reports "zmienione lokalnie"): move the
  user's changes into an own skill with a new name, then "Zastąp zmienione" restores the managed one.

### 5. Inventory row

Add or refresh the row in "Own skills" (outside the markers; create the section at the end of
`CLAUDE.md` when it is missing): `| /<name> | <POSITIVE sentence> | <NEGATIVE sentence> |` under the
header `| Skill | Applies to | Does not apply to |`. Add the skill to `notes/workspace-setup.md`.

## References

| File | Style | Impact | Description |
|---|---|---|---|
| [`references/skill-shape.md`](references/skill-shape.md) | pattern | CRITICAL | The SKILL.md shape for own skills: scope, sections, sizes, reference styles, anti-patterns |

## See also

- `/budget-setup`, `/investments-setup`, `/assets-setup`, `/loans-setup` - module setups; each starts
  with step 1 of this skill in a new workspace.
- `/import-builder` - an importer or connector, not a skill.
- `/extension-builder` - a portfolio rule or alert, not a skill.

## Self-audit checklist

Before telling the user it is done:

1. `notes/workspace-setup.md` exists and lists the own skills.
2. Every own skill folder has POSITIVE / NEGATIVE in its description (at most 1024 characters) and a
   row in "Own skills".
3. No text inside the cashU markers changed and no managed skill was edited.
4. The links are links (`ls -la` shows `->`), or the user knows why one is not (their own file not
   merged yet, no symlink privilege).
5. No personal or financial data in any skill file.
