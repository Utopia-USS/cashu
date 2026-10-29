# Shipped skills (guided setup over MCP)

What this is: what the product skills in `.claude/skills/` do, how a user runs them, the rules every skill follows, and how to edit or add one.

## What this pattern is

The skills are product, not developer tooling: they ship with cashU (`cashu skills install`, the
packaged app) and are copied into each profile's agent workspace (`src/cashu/core/workspace/`). Each
module ships a setup skill in `.claude/skills/<name>/SKILL.md` (plus `references/`). The user connects
the profile's MCP server once, restarts Claude Code, and runs the skill as a slash command in this
repo (or in the profile's workspace):

```bash
claude mcp add cashu-<slug> -- cashu mcp --profile <slug>   # once per profile
```

## What each skill does

| skill | what it does |
|---|---|
| `/workspace-setup` | the profile's agent workspace layout (CLAUDE.md, `AGENTS.md` and `.agents/skills` links for Codex) and the user's own skills built in the same shape (core skill, every workspace) |
| `/budget-setup` | ONBOARDING as a dialogue: banks, CSV vs Open Banking, categorization backend, first categorization pass |
| `/assets-setup` | home, car (depreciation curve) and other manually valued assets |
| `/loans-setup` | mortgages and loans, installment recognition, balances from the bank |
| `/investments-setup` | strategy interview (goals, risk, history retrospective, strategy) and weekly check-ins |
| `/import-builder` | importer for an unsupported broker export or bank statement: preferably a connector (`docs/connectors.md`) the app runs after the owner approves it in Ustawienia > Konektory; else a one-off converter the agent runs, or a generic CSV mapping |
| `/extension-builder` | one custom rule (expression language) with a backtest on the profile's history |
| `/market-research` | weekly research as a local Saturday routine in the profile's workspace (or on demand for one instrument or theme): dated facts, community sentiment flagged as noise and trend data as Polish notes with sources linked to positions and theses; each topic thesis carries one current market view kept by the agent (`set_topic_market_view`: the market now and a market / adoption / demand outlook resting on a sourced quantitative industry estimate (who, how much, horizon; 1-6 `sources` required, stored in `inv_topic_theses.view_sources`, migration 0025), shown as `Ocena teraz` / `Perspektywa` with source links under the thesis, owner-editable via `PUT /investments/topics/{segment}/view`); institutions' forecasts of macro / market trends may be cited as estimates in briefs, segment notes and views; never recommendations, security / index price or valuation predictions, price targets or analyst ratings |

## Rules every skill follows

1. App data only through the profile's MCP tools (never the DB, backups or the import archive).
2. The profile's privacy level decides what the MCP tools give the agent (strict by default: shares
   and percentages, no amounts, never identifiers), while files or rows the user hands over themselves
   are used for the task they asked for (asked once at the import step: the file with values, or the
   recommended blind connector).
3. Configuration changes are proposals the owner approves in the app.
4. The app runs only a connector the owner approved in the app (pinned by content hash, sandboxed,
   with a timeout) and an MCP call never makes it run code (`propose_connector` only installs a
   pending connector; `validate_import` / `propose_import` refuse scripts).
5. No passwords, API keys, IBANs or account numbers (connector keys are entered by the owner in the
   app).
6. Conversation in Polish and files in English.

## Editing or adding a skill

1. Keep its `description` precise (it decides when the skill triggers) and use only tool names from
   the MCP server.
2. Every skill follows the utopia-ai-arch:layer shape: `Applicability - POSITIVE:` and
   `Applicability - NEGATIVE: NOT ...` sentences in the frontmatter `description` (at most 1024
   characters, the workspace CLAUDE.md inventory shows both verbatim), a `## References` table,
   `## See also` and `## Self-audit checklist`. `tests/test_workspace.py::test_shipped_skills_follow_the_layer_shape`
   enforces it.
3. A skill never points at repository files: skills leave the repository, so the docs a skill needs
   are copied into its own `references/` folder. After editing a source doc (`docs/import-format.md`,
   `docs/budget-import-format.md`, `docs/connectors.md`, the strategy README, `EXPRESSIONS.md`) run
   `python scripts/sync_skill_references.py` (`--check` runs in the tests).
   `test_skills_do_not_reference_repository_files` guards it.
4. A new skill must be added to `MODULE_SKILLS` (or `CORE_SKILLS` for one every workspace gets) in
   `src/cashu/core/workspace/skills.py`; `test_every_shipped_skill_belongs_to_a_module` fails
   otherwise.

## See also

- [CLAUDE.md](../../CLAUDE.md) "Skills inventory" - applicability of each skill
- [extending.md](extending.md) "Adding an MCP tool"
- [`docs/connectors.md`](../connectors.md) - the connector contract `/import-builder` targets
