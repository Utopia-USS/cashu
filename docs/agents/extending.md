# Extending cashU

What this is: step-by-step recipes for the typical extensions - a module, a screen, an MCP tool, a CLI command, a store schema change, a connector - in the order the existing code expects.

## When this applies

Adding a capability rather than fixing one. Read [conventions.md](conventions.md),
[data-model.md](data-model.md) and the `cashu-ts-architecture` dev skill first; paths are relative to
the repo root. Every step ends with `pnpm check` and `pnpm arch:check`.

## Bank CSV parsers

**Don't add one for a new bank.** New banks, brokers and exchanges are connectors
([`docs/connectors.md`](../connectors.md)): no code change, and the user's agent can write one
(`import-builder` skill). The built-in parsers are frozen (no new ones) and will move to connectors;
the steps below are only for maintaining the existing mBank / Erste / Pekao parsers.

The three built-ins (`packages/domain/src/budget/ingestion/statements/`: `mbank.ts`, `erste.ts`,
`pekao.ts`, detection in `registry.ts`) already have catalog twins, Deno connectors that produce the
same rows: [`connectors/mbank-csv`](../../connectors/mbank-csv/), [`erste-csv`](../../connectors/erste-csv/)
and [`pekao-csv`](../../connectors/pekao-csv/). The switch-over (removing the built-ins, the import
path then going through the connectors) is pending the owner's check on real exports. Until then
**a fix to a built-in parser must be ported to its twin** (`parse.ts`; `pycompat.ts` next to it holds the
Python-compatible primitives). Differences that remain by design: a connector document goes
through the newest-day rule (a late row inside the stored span is overlap, not new), and a title over
200 characters or a counterparty account number under 8 characters cannot be carried as the built-in
keeps them.

1. Change the parser and keep the bank's Polish CSV headers verbatim - they are matched against the
   file. Each bank has `<bank>.test.ts` next to it; the synthetic fixtures in
   `packages/domain/test/fixtures/budget-csv/` are byte copies of the connectors' `fixtures/`
   (`fixtures.test.ts` checks it), so a new fixture goes into both.
2. A bank's registry entry is one `Institution` in `BUILTIN_INSTITUTIONS`
   (`packages/domain/src/core/institutions.ts`): id, kind `bank`, display name, its CSV importer and
   the `aspsp_patterns` that map its Enable Banking ASPSP name. An ASPSP without an entry syncs under a
   generic id slugged from its name (e.g. `ing-bank-slaski`); when you add an entry for such a bank,
   use that slug as the id, or its existing Open Banking accounts no longer match the new id.

## Adding a module

1. Domain: a folder `packages/domain/src/<id>/` with its pure rules, setup steps (`setup.ts` +
   `setup.strings.ts`) and, if it values accounts, a `NetWorthContributor` (`networth.ts`); its
   `ModuleSpec` in `packages/domain/src/core/builtinModules.ts` and its id in `MODULE_IDS`
   (`core/modules.ts`).
2. Store: `packages/store/src/<id>/` with its events (`events/v1/`, documented in
   `packages/store/spec/events.md`), materializers, queries and commands, registered as a
   `StoreModule` in `packages/store/src/modules.ts`.
3. Text: catalogs in `packages/i18n/src/<id>/`, platform-free UI logic in `packages/ui-logic/src/<id>/`.
4. Surfaces: screens in `apps/desktop/renderer/screens/<id>/` (below), CLI commands in
   `apps/host/src/cli/<id>/`, MCP tools in `packages/mcp/src/tools/<id>.ts`.
5. Its setup skill: see [skills.md](skills.md) (add it to `MODULE_SKILLS`).
6. Never import another module's internals.

## Adding a screen

1. Data: a query in the module's store folder (`defineQuery`), or host screen data
   (`apps/host/src/*Screen.ts`) when it needs host-only sources; writes are commands.
2. UI: `apps/desktop/renderer/screens/<feature>/` with a screen hook `use<Feature>Screen.ts` (all state
   and data, `useQuery` from `@cashu/store-react`), a pure `<Feature>View.tsx` (props in, no store
   access), a `<Feature>.strings.ts` catalog and a Storybook story for the View (a guard requires it);
   wire the route in `apps/desktop/renderer/routes.tsx`. Shared components and charts come from
   `@cashu/ui` with design tokens only (no raw colours or spacing; a guard checks it).
3. Copy: follow the UI copy rules in [conventions.md](conventions.md); new backend codes get a label in
   `packages/ui-logic/src/core/messages.ts`; update or add the matching e2e spec in
   `apps/desktop/e2e/desktop-specs/` ([running.md](running.md)).

## Adding a CLI command

Implement a `PortedCommand` (`{ name, run(args, io, root) }`, `apps/host/src/cli/tree.ts`) in the
module's folder under `apps/host/src/cli/`, register it in `portedCommands()`
(`apps/host/src/cli/ported.ts`), add its usage to `HELP` in `apps/host/src/cli/help.strings.ts` and
its texts to a `*.strings.ts` catalog. Resolve the profile from `root.profile` (else `CASHU_PROFILE`,
else the default profile) and print only through `io.stdout` / `io.stderr`
([conventions.md](conventions.md) rule 7). Try it from the checkout with `pnpm cashu-next <command>`.

## Changing an event or a view

Follow [data-model.md](data-model.md) rule 15: a new event version with an upcaster (or an optional
field that keeps the old meaning), or a bumped materializer / deriver version; update
`packages/store/spec/events.md` in the same change (the catalog test compares them); run
`pnpm --filter @cashu/store test`, which includes the upgrade and view-upgrade tests.

## Adding an MCP tool

The MCP server lives in `packages/mcp/src/` (read the module comments before editing):

- A tool is a `ToolSpec` (`registry.ts`, built with `toolSpec()`) in the module's
  `packages/mcp/src/tools/<module>.ts`. A spec names its module (`core` = always available, otherwise
  listed and callable only while that module is enabled, `also` for extra modules), an input schema
  (no additional properties, never a profile argument: the session serves one vault) and a handler
  returning a labelled tree; throw `ToolError` for problems the agent can fix. Add it to `TOOL_ORDER`
  / the schemas in `runtime/toolSchemas.ts` and to the matching authority set in
  `apps/host/src/localHost/mcp.ts`.
- Every returned value is wrapped with a sensitivity label (`privacy/labels.ts`); the redactor
  (`privacy/redactor.ts`) decides per label and privacy level what is sent, and an unlabelled leaf
  fails the call closed. Configuration changes an agent suggests are proposals the owner approves in
  the app (`packages/store/src/core/proposals.ts`).
- Tests: the module's `packages/mcp/src/tools/<module>.test.ts`, `runtime/server.test.ts`, the
  privacy tests in `privacy/`, and `apps/host/src/mcp/tools.test.ts` (pins the tool inventory).
- Skills may only use tool names the server exposes ([skills.md](skills.md)).

## Adding an importer or connector

- Investments imports: the cashU format ([`docs/import-format.md`](../import-format.md)), a generic
  CSV mapping or an approved connector - never a broker-specific parser in the code base.
- Budget imports: the budget import format ([`docs/budget-import-format.md`](../budget-import-format.md))
  or a connector.
- Connectors: contract in [`docs/connectors.md`](../connectors.md), JSON Schemas in `docs/schemas/`
  (generated from `apps/host/src/connectors/jsonSchemas.ts` and the domain import schemas:
  `pnpm --filter @cashu/host gen:connector-schemas` after a change, `--check` verifies), tested
  examples in `examples/connectors/`, the runtime in `apps/host/src/connectors/` and
  `apps/host/src/connectorRuntime.ts`. After editing a doc a skill copies, run
  `pnpm --filter @cashu/host skills:sync` ([skills.md](skills.md)).

## Packaging

`node apps/desktop/scripts/package-macos.mjs <arm64|x64>` builds cashU.app; details in
[running.md](running.md) "Packaging", update and release rules in
[s47-update-operator.md](s47-update-operator.md).

## See also

- [code-map.md](code-map.md), [data-model.md](data-model.md), [conventions.md](conventions.md)
- [skills.md](skills.md) - shipped skills and their rules
- [running.md](running.md) - verifying the change
