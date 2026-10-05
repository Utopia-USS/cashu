"""Per-profile agent workspace: a folder where the owner runs Claude Code for one profile, with a
managed CLAUDE.md, the profile's MCP server, the enabled modules' skills and permission rules that
keep Claude Code's file tools out of the finanse data (see ``service``).

- ``service``: paths, status, create / update, refresh after a module or privacy change;
- ``render``: the managed file contents; ``skills``: which module brings which skill;
- ``api``: ``GET/POST /api/p/{slug}/workspace``, ``GET /api/workspaces/default``;
- ``cli``: ``finanse workspace init|update|path``.
"""
