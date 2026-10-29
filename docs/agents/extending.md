# Extending cashU

What this is: step-by-step recipes for the typical extensions - a bank, a module, a dashboard feature, a migration, an MCP tool, a connector - in the order the existing code expects.

## When this applies

Adding a capability rather than fixing one. Read [conventions.md](conventions.md) and
[data-model.md](data-model.md) first; paths are relative to the repo root.

## Adding a new bank (CSV parser)

**Don't, for a new bank.** New banks, brokers and exchanges are connectors
([`docs/connectors.md`](../connectors.md)): no code change, and the user's agent can write one
(`import-builder` skill). The built-in parsers are frozen (no new ones) and will move to connectors;
the steps below are only for maintaining the existing mBank / Erste / Pekao parsers.

The three built-ins already have catalog twins, Deno ports that produce the same rows:
[`connectors/mbank-csv`](../../connectors/mbank-csv/), [`erste-csv`](../../connectors/erste-csv/) and
[`pekao-csv`](../../connectors/pekao-csv/). The switch-over (removing the built-ins, the import path
then going through the connectors) is pending the owner's check on real exports. Until then **a fix to
a built-in parser must be ported to its twin** (`parse.ts`; the shared `pycompat.ts` holds the
Python-compatible primitives): `tests/test_catalog_bank_parsers.py` asserts that both give the same
content keys, account, currency and balances on every fixture, and fails otherwise. It also pins the
differences that remain by design: a connector document goes through the newest-day rule (a late row
inside the stored span is overlap, not new), and a title over 200 characters or a counterparty
account number under 8 characters cannot be carried as the built-in keeps them.

1. New file `src/cashu/modules/budget/ingestion/csv_import/<bank>.py` - a thin config on top of the
   engine in `base.py` (model it on `mbank.py`/`pekao.py`: encoding, separator, columns, where
   currency/IBAN/balance come from; set `bank = "<id>"`). Keep the bank's Polish CSV headers verbatim -
   they are matched against the file.
2. Add one `Institution` entry to `BUILTIN` in `src/cashu/core/institutions.py`: id, kind `bank`,
   display name, `csv_importer="<module path>:<Class>"` and the `aspsp_patterns` that map its Enable
   Banking ASPSP name. Import, auto-detection, `--bank` choices and `statements/<id>/` directories pick
   it up from there. An ASPSP without an entry already syncs under a generic id slugged from its name
   (`institutions.slug_id`, e.g. `ing-bank-slaski`); when you add an entry for such a bank, use that
   slug as the id, or its existing Open Banking accounts no longer match the new id.
3. Add a test in `tests/test_parsing.py` using a **synthetic** sample of the format.

## Adding a module

1. A package `src/cashu/modules/<id>/` with its tables (`models.py`, plus an Alembic revision, see
   below).
2. `module.py` exporting `MODULE = ModuleSpec(...)`: Polish name/description (wizard), router, CLI
   `register` (and/or `cli_module` for its sub-app, named `cli_name` or the id), optional
   `NetWorthContributor`, account types / buckets / institutions it owns, categorization hooks,
   `setup_status(session, profile_id)` (blank-page steps) and its setup skill.
3. Add the id to `MODULE_IDS` in `src/cashu/core/modules.py`.
4. Live data for its list entities: watched tables and list-row payloads in `modules/<id>/live.py`
   (see [data-model.md](data-model.md) rule 14).
5. Its setup skill: see [skills.md](skills.md) (register it in `MODULE_SKILLS`).
6. Never import another module's internals.

## Adding a dashboard feature

1. Endpoint in the module's `api.py` router (plain JSON). Take the profile with a
   `profile: CurrentProfile` parameter and pass `profile_id=profile.id` to every query; the app mounts
   module routers under `/api/p/{slug}/...` and as legacy `/api/...` aliases.
2. Add the route to `PROFILE_GETS` in `tests/test_profiles.py` (a guard test fails otherwise): it
   checks that two profiles never see each other's data. Investments routes have their own list in
   `tests/investments/persistence/test_invp_isolation.py`.
3. Every `/api/*` route is behind the token + Host check automatically (`core/security.py`); in tests
   use a `TestClient` with `base_url=security.get_config().base_url` and the `X-Cashu-Token` header
   (see `tests/conftest.py`).
4. Type + function in the frontend API client (mirror the JSON shape); call it through
   `j`/`jpost`/`jdel` (`frontend/src/core/api.ts`), which send the token; each module keeps its
   client in `frontend/src/modules/<id>/api.ts`.
5. Component in `frontend/src/components/` or a new tab (UI strings stay Polish); module tabs live in
   `frontend/src/modules/<id>/`.
6. Line/bar charts: widgets on Przegląd / Inwestycje use `charts.tsx` (SVG drawn at the measured
   width, colours from the CSS tokens, geometry tested in `chart.ts`); the budget and loan pages use
   `components/ScrollableChart.tsx` (window+scroll+axis+grid). Don't add zoom/pan plugins to
   Chart.js - they were removed as janky.
7. Copy: follow the frontend copy rules in [conventions.md](conventions.md); new backend codes get a
   Polish label in `frontend/src/core/messages.ts`; update the matching e2e spec
   ([running.md](running.md)).

## Adding a CLI command

Put it in the module's `cli.py`, add it through `register(app)` and/or the module's sub-app, resolve
the profile with `core.cliutil.profile(session)` and print through `core.cliutil.console`
([conventions.md](conventions.md) rule 7).

## Adding a migration

Change the model, then from the repo root
`CASHU_DATA_DIR=/tmp/x alembic revision --autogenerate -m "..."`; use `op.batch_alter_table` for
existing tables; run `pytest tests/test_migrations.py`. Backup and stamping behaviour:
[data-model.md](data-model.md) rule 15.

## Adding an MCP tool

The MCP server lives in `src/cashu/core/mcp/` (read the module docstrings before editing):

- A provider module `core/mcp/tools/<module>.py` exports `TOOLS: tuple[ToolSpec, ...]`
  (`core/mcp/registry.py`). A spec names its module (`core` = always available, otherwise listed and
  callable only while that module is enabled), an input schema (JSON Schema, no additional
  properties, never a profile argument: the server serves one profile) and a handler returning a
  labelled tree; raise `ToolError` for problems the agent can fix.
- Every returned value is wrapped with a sensitivity label (`core/mcp/labels.py`); the redaction layer
  (`core/mcp/redaction.py`) decides per label and privacy level what is sent, and an unlabelled leaf
  fails the call closed. Configuration changes an agent suggests are proposals the owner approves in
  the app (`core/proposals.py`).
- Tests: `tests/test_mcp_tools.py`, `tests/test_mcp_redaction.py`, `tests/test_fxb_mcp_privacy.py`
  and the module-specific `tests/test_*_mcp.py`.
- Skills may only use tool names the server exposes ([skills.md](skills.md)).

## Adding an importer or connector

- Investments imports: the cashU format ([`docs/import-format.md`](../import-format.md)), a generic
  CSV mapping or an approved connector - never a broker-specific parser in the code base.
- Budget imports: a bank CSV parser (above), the budget import format
  ([`docs/budget-import-format.md`](../budget-import-format.md)) or a connector.
- Connectors: contract in [`docs/connectors.md`](../connectors.md), JSON Schemas in `docs/schemas/`
  (regenerate with `python scripts/gen_connector_schemas.py` after changing a model), tested examples
  in `examples/connectors/`, code in `src/cashu/core/connectors/`.

## Packaging

`scripts/build_macos.sh` builds cashU.app; the decisions behind the build inputs (hash-pinned
`packaging/requirements-build.lock`, entitlements, signing) are in
[`packaging/README.md`](../../packaging/README.md).

## See also

- [code-map.md](code-map.md), [data-model.md](data-model.md), [conventions.md](conventions.md)
- [skills.md](skills.md) - shipped skills and their rules
- [running.md](running.md) - verifying the change
