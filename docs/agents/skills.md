# Shipped skills (guided setup over MCP)

What this is: what the product skills in `.claude/skills/` do, how a user runs them, the rules every skill follows, and how to edit or add one.

## What this pattern is

The skills are product, not developer tooling: they ship inside cashU.app (`Contents/Resources/skills`,
copied by the packaging script) and are copied into each profile's agent workspace
(`apps/host/src/workspace/`; the app creates the workspace in the profile wizard or in Settings >
AI agent (MCP), the CLI with `cashu --profile <slug> workspace init`). Each module ships a setup skill
in `.claude/skills/<name>/SKILL.md` (plus `references/`). The workspace's `.mcp.json` registers the
profile's MCP server (`cashu-<slug>`, running `cashu mcp --profile <slug>` through the installed app's
shim), so the user opens the workspace in Claude Code and runs a skill as a slash command. Outside a
workspace, register the server once per profile and copy the skills with `cashu skills install`
(into `~/.claude/skills`):

```bash
claude mcp add cashu-<slug> -- "$HOME/Library/Application Support/cashU/bin/cashu" mcp --profile <slug>
```

## What each skill does

| skill | what it does |
|---|---|
| `/workspace-setup` | the profile's agent workspace layout (CLAUDE.md, `AGENTS.md` and `.agents/skills` links for Codex) and the user's own skills built in the same shape (core skill, every workspace) |
| `/budget-setup` | ONBOARDING as a dialogue: the app, banks, CSV vs Open Banking, categorization backend, first categorization pass |
| `/assets-setup` | home, car (depreciation curve) and other manually valued assets |
| `/loans-setup` | mortgages and loans, installment recognition, balances from the bank |
| `/investments-setup` | strategy interview (goals, risk, history retrospective, strategy) and check-ins against the strategy |
| `/import-builder` | importer for an unsupported broker export or bank statement: preferably a connector (`docs/connectors.md`) the app runs after the owner approves it in Ustawienia > Konektory; else a one-off converter the agent runs, or a generic CSV mapping |
| `/extension-builder` | one custom rule (expression language) with a backtest on the profile's history |
| `/review` | the periodic review deck in chat, the same cards as the app (`review_context` + the read tools), the owner's decisions, `mark_review_done` with the agenda the next research run reads (`research_context.owner_review`); rhythm, name and cards live in strategy.yaml `review:` |
| `/market-research` | weekly research as a local Saturday routine in the profile's workspace (or on demand for one instrument or theme): dated facts, community sentiment flagged as noise and trend data as notes in the owner's language with sources linked to positions and theses; each topic thesis carries one current market view kept by the agent (`set_topic_market_view`: the market now and a market / adoption / demand outlook resting on a sourced quantitative industry estimate (who, how much, horizon; 1-6 `sources` required), shown as `Ocena teraz` / `Perspektywa` with source links under the thesis, owner-editable in the app); institutions' forecasts of macro / market trends may be cited as estimates in briefs, segment notes and views; every routine ends with the model's assessment of each held and watched instrument (`set_recommendations`, `scope: all`: a position strength `strong` / `neutral` / `weak` with a basis and a reason in the owner's language, required and counted by the coverage gate; a buy / hold / reduce / exit recommendation only when the agent is willing to state one as a model opinion); notes and views hold facts, never recommendations, security / index price or valuation predictions, price targets or analyst ratings (the wording check warns and asks the agent to confirm); a price target or forecast that follows from the owner's strategy goes only in the recommendation's reason, as the model's opinion |

## Rules every skill follows

1. App data only through the profile's MCP tools (never the stores, backups or the import archive).
2. The profile's privacy level decides what the MCP tools give the agent (strict by default: shares
   and percentages, no amounts, never identifiers), while files or rows the user hands over themselves
   are used for the task they asked for (asked once at the import step: the file with values, or the
   recommended blind connector).
3. Configuration changes are proposals the owner approves in the app.
4. The app runs only a connector the owner approved in the app (pinned by content hash, sandboxed,
   with a timeout) and an MCP call never makes it run code on the owner's behalf: `test_connector`
   only runs a connector of the agent's own workspace once, sandboxed and offline, on a workspace file,
   returning a value-free report, and never installs or approves (`propose_connector` only installs a
   pending connector; `validate_import` / `propose_import` refuse scripts).
5. No passwords, API keys, IBANs or account numbers (connector keys, the Enable Banking key and the
   Anthropic key are entered by the owner in the app).
6. Conversation and everything the owner reads in the app language (the cashU MCP server's
   instructions name it; Polish when unsure), files in English.
7. CLI commands a skill shows are the native `cashu` command of the installed app (the launcher
   `<data dir>/bin/cashu`); a skill never asks the user to install Python, a package manager or a
   checkout to use cashU. User-written connectors and converters may still be Python run by the
   user's own `python3` (`import-builder`), never the cashU code.

## Editing or adding a skill

1. Keep its `description` precise (it decides when the skill triggers) and use only tool names from
   the MCP server (`packages/mcp/src/runtime/toolSchemas.ts`).
2. Every skill follows the utopia-ai-arch:layer shape: `Applicability - POSITIVE:` and
   `Applicability - NEGATIVE: NOT ...` sentences in the frontmatter `description` (at most 1024
   characters, the workspace CLAUDE.md inventory shows both verbatim), a `## References` table,
   `## See also` and `## Self-audit checklist`. `apps/host/src/workspace/workspace.test.ts` checks the
   inventory's name, version and applicability sentences.
3. A skill never points at repository files: skills leave the repository, so the docs a skill needs
   are copied into its own `references/` folder (`COPIES` in `apps/host/src/workspace/skillReferences.ts`).
   After editing a source doc (`docs/import-format.md`, `docs/budget-import-format.md`,
   `docs/connectors.md`, `docs/schemas/`, `examples/connectors/`, the strategy schema,
   `packages/domain/src/investments/rules/expr/EXPRESSIONS.md`) run
   `pnpm --filter @cashu/host skills:sync`; `skillReferences.test.ts` (and `skills:sync --check`)
   fails while a copy is stale.
4. A new skill must be added to `MODULE_SKILLS` in `packages/domain/src/core/workspace/plan.ts` (or to
   the always-on list in `apps/host/src/workspace/production.ts` for one every workspace gets).
5. The packaged app seals its skills: `apps/host/src/bundleIdentity.test.ts` rejects modified shipped
   skills, so a skill change ships only with a new build.

## See also

- [CLAUDE.md](../../CLAUDE.md) "Skills inventory" - applicability of each skill
- [extending.md](extending.md) "Adding an MCP tool"
- [`docs/connectors.md`](../connectors.md) - the connector contract `/import-builder` targets
