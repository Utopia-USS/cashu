# Own skill shape

What this is: the shape of a skill the user adds to their cashU workspace, condensed from the
utopia-ai-arch:layer blueprint (plugin `utopia-ai-arch`, github.com/Utopia-USS/utopia-flutter-skills)
for a workspace instead of an app repository.

## When this applies

Writing a new own skill in `.claude/skills/<name>/`, or converting an existing one or a block of own
instructions into a skill.

## Rules

1. **Positive and negative applicability in the description.** The description is the only signal
   that makes the agent load a skill. Without a negative scope a skill fires everywhere and crowds
   out the right one. If you cannot write the negative sentence, the skill has no real boundary:
   merge it into another skill or split it.
2. **The description says WHEN, not WHAT.** "Use when the user asks for X" routes; "This skill
   teaches X" does not. At most 1024 characters: Codex rejects longer ones.
3. **No router skill.** A skill that only points at other skills either fires too broadly or too
   narrowly. The inventory and routing belong in `CLAUDE.md` ("Own skills"), which is always loaded.
4. **No "shared" skill.** "Shared" is not a scope. Content two skills need goes into one skill's
   `references/` and the other links to it from its "See also".
5. **Cross-links live in SKILL.md.** SKILL.md always loads with the skill, references only on
   demand: a link buried in a reference is two hops away and gets lost.
6. **SKILL.md stays short (about 200 lines).** Deep content goes into `references/`, read only when
   the mapping table sends the agent there. Context is finite.
7. **Do not restate the workspace.** Privacy, boundaries, the tool list and folders are owned by the
   workspace `CLAUDE.md`; a restatement drifts when cashU updates it. Keep only the safety lines this
   skill needs on its own (it may run outside the workspace).
8. **One source, links not copies.** Never copy a managed skill or `CLAUDE.md`; link to them.
   Copies drift silently.
9. **No personal or financial data.** The skill fetches data through MCP when it runs.
10. **The inventory changes with the skill.** A new, renamed or deleted skill updates its "Own
    skills" row in the same change.

## How to apply

```markdown
---
name: <name>
description: >
  Use when <the user's situation, one sentence>.
  Applicability - POSITIVE: <one sentence>.
  Applicability - NEGATIVE: NOT <one sentence, naming the skill that covers each case>.
  Triggers: /<name>, "<Polish phrase>", "<Polish phrase>".
---
# <name>: <title>
<One framing paragraph.>
## Relationship to the workspace   (table: the workspace owns | this skill adds)
## Non-negotiable                  (the rules the agent must not break)
## Problem -> reference mapping    (table: task | where to start)
## Steps                           (the procedure, or a short skeleton linking to references)
## References                      (table: file | style | impact | description)
## See also                        (other skills, one line each)
## Self-audit checklist            (checks before saying "done")
```

Reference styles (pick by content, name the file after it):

| Content | Style | File name |
|---|---|---|
| a procedure someone or the agent follows | workflow | `<topic>-workflow.md` |
| rules with a reason each | pattern | `<topic>-pattern.md` |
| an inventory, tables only | cheatsheet | `<topic>-cheatsheet.md` |
| a user flow with business intent | module | `<feature>-module.md` |

Every reference starts with a `# Title` and one line "What this is".

## Anti-patterns

- A description listing what the skill contains instead of when to use it.
- A SKILL.md of 600 lines with every detail inline.
- A skill that repeats the boundaries from `CLAUDE.md` word for word.
- A copy of `CLAUDE.md` saved as `AGENTS.md`, or of `.claude/skills` as `.agents/skills`.
- Amounts or account numbers written into a skill "as an example".
