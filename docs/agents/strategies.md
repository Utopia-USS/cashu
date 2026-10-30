# Strategies: free documents, optional structure

Design note for the move from one strategy per profile to a list of strategies. Stage 1 (the
**Strategie** tab, read-only) is built; stages 2-3 are the plan.

## Why

People invest in very different ways: rules and target allocation (the current `strategy.yaml`), signals
from an external tool, picks checked against a Telegram group, plain discretion with a checklist. Some
strategies cover one account, some the whole portfolio, and two strategies may look at the same holdings
(a running one and a new one being tried, or two lenses on the same money). A fixed schema with a
mandatory scope and kind cannot hold all of that, so the app stops trying to understand a strategy.

## Model

- **A strategy is a document.** A Markdown file written by the profile's agent in whatever shape fits the
  user. Scope, kind, signal sources and how it relates to other strategies are prose in that document;
  the app does not interpret them. The agent reads the documents during check-ins, reviews and research.
- **Structure is optional and only for what the app executes.** A YAML file next to the document holds
  the parts the app must watch: rules and alerts, the contribution plan, the review rhythm. A strategy
  without YAML is a pure document; the app shows it and nothing fires from it. Say that to the user.
- **Optional frontmatter** (`title`, `status`, `description`) only feeds the list. Without it the title is
  the first `# ` heading, else the file name.
- **Overlap is allowed.** Strategies may share holdings; nothing forces a scope.
- **The one singular setting is the base currency**, which moves to the profile (stage 2): the portfolio
  cannot be valued without it.

## Files

```
profiles/<slug>/
  strategy.md, strategy.yaml      # the existing strategy: the first entry ("main"), executed as today
  strategies/
    <id>.md [+ <id>.yaml]         # a one-file strategy
    <id>/ *.md, *.yaml, *.txt     # a folder strategy (notes, checklists, source descriptions)
```

All of it lives in the data dir, never in the repository. Ids are file or folder names
(`[a-z0-9][a-z0-9_-]*`); hidden files, symlinks and files outside the strategy are ignored.

## Stage 1 (built): the Strategie tab

- `GET /investments/strategies` lists the strategies with their files, frontmatter and, for `main`, the
  validation state. `GET /investments/strategies/{id}/file?path=...` returns one file's text.
  Code: `modules/investments/service/strategy_docs.py`.
- The tab is IDE-shaped: the file tree on the left, the rendered Markdown in the middle, YAML with the
  validation issues of `main` marked on their lines. Only `main` is executed; YAML in `strategies/` is
  shown with a "not run by the app yet" note.
- No editing in the app. Changes still go through agent proposals (`propose_strategy`) that the owner
  approves; the tab offers a reload.

## Stage 2 (plan): several executed strategies

- Every strategy's YAML is loaded; the parts are merged: contributions add up, each strategy may have its
  own review rhythm or none, rule ids are namespaced by strategy id. Conflicts (the same rule twice,
  contradicting targets for one bucket) are validation warnings the agent resolves, not hard errors.
- `InvSignal` and `InvStrategyVersion` get a `strategy_id`; a decision in the journal records which
  strategy it followed, so contradicting signals of overlapping strategies are visible and resolvable.
- The base currency moves to the profile settings.
- About 20 callers of `service.strategy.load(session, profile)` assume one config: they move to a merged
  view first, then become strategy-aware where it matters (signals, review, contributions).

## Stage 3 (plan): the skill

`investments-setup` stops assuming one archetype: it first finds out the user's style and sources, then
writes the document freely, and adds automation only where the user wants the app to watch something:
a rule through `extension-builder`, a signal feed from an external tool as a connector through
`import-builder`. Credentials for such sources (a Telegram session, an API key) are entered by the user,
never by the agent.
