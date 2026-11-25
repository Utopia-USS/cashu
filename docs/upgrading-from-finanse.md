# Upgrading from finanse

cashU was called finanse before the rename (legacy name). The native cashU app does not read a
finanse install directly: it imports only a cashU data dir written by the last release of the Python
cashU app. An install of finanse therefore moves in two steps.

## 1. finanse to the last Python cashU release

Install and open the last Python cashU release once. On its first start it moves the old data dir
(`~/Library/Application Support/finanse`, legacy name) to `~/Library/Application Support/cashU`,
moves secrets from the keychain service `finanse` to `cashu` (legacy name in the first) and upgrades
the database to its last schema. Quit it afterwards.

## 2. Python cashU to the native app

The native app does not import the Python data dir. On its first start it shows the old-data screen
(also for a database still named `finanse.db`, legacy name, or one left in
`~/Library/Application Support/finanse`): its prompt sends your agent through the import-builder
skill, section "Old cashU (Python) data", which converts the old data into the import formats for you
to approve in the app. The old files are never opened, moved or changed by the app.

## What keeps working

- `FINANSE_DATA_DIR` (legacy name) is still read by the `cashu` command when `CASHU_DATA_DIR` is not
  set.
- Import documents with the old format ids are accepted.
- An agent workspace made by finanse (legacy name) is recognised and updated in place.

## What you do once

- Agent workspaces stay where they are: update each profile's workspace in the app (Settings >
  AI agent (MCP)) or with `cashu --profile <slug> workspace update`.
- Re-add a Claude Code MCP server registered by hand as `cashu-<slug>`, pointing at the native app's
  launcher:

  ```bash
  claude mcp add cashu-<slug> -- "$HOME/Library/Application Support/cashU/bin/cashu" mcp --profile <slug>
  ```
