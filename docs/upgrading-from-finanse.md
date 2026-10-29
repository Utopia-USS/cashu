# Upgrading from finanse

cashU was called finanse before the rename (legacy name). An install of finanse upgrades itself on
the first start of cashU; this page lists what moves and what you do by hand.

## What happens automatically

The first start of cashU (the app or any `cashu` command) moves the old data dir
(`~/Library/Application Support/finanse`, legacy name) to `~/Library/Application Support/cashU`
and renames its database to `cashu.db`, unless something still uses it (close the old app first;
Ustawienia > Aplikacja shows a step that could not run). Secrets move from the keychain service
`finanse` to `cashu` (legacy name in the first), and an installed background job is reinstalled
under its new label.

## What keeps working for now

- The old `finanse` command (legacy name) still works and prints a deprecation line.
- `FINANSE_*` variables (legacy name) are read when the `CASHU_*` one is not set.
- Import documents with the old format ids are accepted.

## What you do once

- Agent workspaces stay where they are: run "Aktualizuj workspace" (Ustawienia > Agent AI) or
  `cashu workspace update` once per profile.
- Re-add a Claude Code MCP server registered by hand as `cashu-<slug>`:

  ```bash
  claude mcp add cashu-<slug> -- cashu mcp --profile <slug>
  ```
