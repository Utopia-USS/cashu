# Conventions

What this is: the code, language, versioning, CLI, test and UI-copy rules of the repo, each with its reason, plus the "What NOT to do" list.

## What this pattern is

How the existing code is shaped, so new code fits it. Domain rules (profiles, currencies, transfers,
store schema evolution) live in [data-model.md](data-model.md); step-by-step recipes live in
[extending.md](extending.md); the TypeScript architecture (layers, screen hook + pure View, data flow,
performance, testing) lives in the `cashu-ts-architecture` dev skill
(`tools/claude-dev/skills/cashu-ts-architecture/`), the UI system in `cashu-ui`.

## When this applies

Every change to `packages/`, `apps/`, `tools/` or the docs.

## Rules

### Language

1. **The codebase is English** (comments, docs, CLI help). Why: it is code language for developers.
2. **The UI is Polish and English; matching data stays Polish.**
   - **Every text the app shows** (screen copy, backend labels, CLI output, notifications) exists in
     both languages: `*.strings.ts` catalogs (`catalog({ key: { pl, en } })` from `@cashu/i18n`), and
     backend code renders through an explicit `Translator` (`io.t` in a CLI command). Why: the tool
     targets Polish-bank users, who do not all use the app in Polish. Contract and glossary:
     [localization.md](localization.md).
   - **Matching data**: CSV column headers detected in the parsers (`#Data operacji`,
     `Rachunek źródłowy`, ...) in `packages/domain/src/budget/ingestion/statements/`, the ~420 PL seed
     rules in `budget/categorize/seedRules.ts`, the installment phrases in `loans/patterns.ts`, and
     the LLM prompts in `budget/categorize/llm/prompts.ts`. Why: they are matched against Polish bank
     transaction text - translating them breaks categorization on real data.
3. **Rule of thumb:** if a string is **explanation for a developer** -> English. If it is **shown to
   the user** -> both languages through a catalog / `Translator`. If it is **data** (matched, or sent
   to the LLM as a prompt/enum) -> leave it Polish.
4. **Never the em dash; use a hyphen** (code, UI copy, docs). Product names (Claude Code, MCP, Enable
   Banking) stay as they are.

### Versions

5. **Never bump the version in a normal change.** The app version is `version` in
   `apps/desktop/package.json` (every other package stays `0.0.0`). The `bump-version` workflow
   raises it on every merge to `main` (`apps/desktop/scripts/bump-version.mjs`: patch by default,
   `[minor]` / `[major]` / `[skip bump]` in a commit message, a hand-set version is kept). Changes reach `main` through `staging`: every
   push to `staging` opens or updates the `staging -> main` pull request (`staging-to-main-pr`
   workflow). Pushing to `staging` releases nothing; the merge to `main` bumps the version and starts
   the release workflow, which waits for the owner's approval ([releasing.md](../releasing.md)).

### Module boundaries and layers

6. **A module never imports another module's internals.** Cross-module needs go through core
   (net-worth contributors, account types, institutions, categorization hooks). Package dependencies
   follow the layer table (`LAYERS` in `tools/arch/depcruise.config.cjs`), and an app never imports
   another app. Why: modules are switched on and off per profile, and the layers keep the domain pure
   and portable to the phone. `pnpm arch:check` enforces both.

### CLI

7. A command is a `PortedCommand` in the module's folder under `apps/host/src/cli/` (it parses its own
   arguments), registered in `portedCommands()` (`apps/host/src/cli/ported.ts`) with its usage in
   `help.strings.ts`; it writes only through `io.stdout` / `io.stderr` and renders text through
   `io.t`. The shim (`apps/cli/`) knows only `app`, `host`, `migrate` and `mcp`; never add a command
   there. Why: commands run inside the host, which owns the stores, so the shim of an installed app
   never changes when commands do.

### Tests

8. `vitest` per package, in two tiers (`vitest.tiers.ts`): the default tier runs every `*.test.ts(x)`;
   `*.exhaustive.test.ts` runs only under `CASHU_TEST_TIER=exhaustive` (`pnpm test:exhaustive`).
   Every package uses the tiered config and has a `test:exhaustive` script (a guard checks it).
   **Always synthetic data. Never paste real statements.** Use temp data dirs (never the real data
   dir) and, for keys, only `createTestKeyStore` from `@cashu/node-host/testing` (service namespace
   `cashu-next-test.*`); a real keychain item is never created. If temp-path tests fail on macOS,
   `export TMPDIR=$(cd "$TMPDIR" && pwd -P)/`. Why: the repo must never hold real financial data (see
   the data-safety rules in [CLAUDE.md](../../CLAUDE.md)).
9. Helpers: `packages/domain/src/testing/seedHousehold.ts` (a synthetic household),
   `packages/store/src/testing/`, `packages/node-host/src/testing/` (fixture hosts) and
   `apps/host/src/testing/` (synthetic hosts and demos). Testing rules:
   `tools/claude-dev/skills/cashu-ts-architecture/references/testing.md`.

### UI copy (minimal and glanceable, in Polish and English)

Before adding or changing a string:

10. A screen, card or widget never explains what it is for: the title and the data say it. No
    paragraph under a heading; context needed less than monthly goes into a tooltip (`title` on the
    label, switch or button), never an inline muted paragraph.
11. Labels are 1-3 word nouns (table headers one word where possible); buttons are 1-2 word verbs
    (Zapisz / Save, Importuj / Import, Cofnij / Undo); the object is implied by the card. The English
    copy follows the same rules ([localization.md](localization.md)).
12. Empty state = one line (a state, not an apology) + one action button. Errors say what to do in the
    same line: "Nie udało się X: {detail}" or "{problem}. {action}." (no "Próbuję ponownie", no
    apology).
13. Only two kinds of notes, one sentence each: privacy / safety (what the agent sees, that in-app
    analyses never leave the machine, an agent write is always a proposal approved in the app) and
    irreversible actions. "Nothing leaves the machine" only where literally true (the app's own
    analyses); never imply that what an agent gets through MCP stays local: MCP tool results go to the
    Claude API. Shared copy lives in one catalog entry, never two versions on two screens.
14. Numbers first: `12 400 zł · 3 konta`. Status words are single adjectives / short tags (gotowy,
    w toku, nieaktualne). Refresh mechanics stay invisible ("co 5 s", "na żywo", "odświeża się").
15. Backend codes get labels in `packages/ui-logic/src/core/messages.ts` (strategy issues, import
    warnings, proposals, error codes, `perf.<code>`, `worker.<code>`).
16. When you change UI copy or structure, keep the e2e specs (`apps/desktop/e2e/desktop-specs/`) on
    roles, labels and aria names rather than long texts, and update the matching spec in the same
    change. Why: long texts change often and make the specs brittle.

## What NOT to do

| Don't | Why |
|---|---|
| Sum different currencies into a single net-worth figure | net worth is per currency ([data-model.md](data-model.md) rule 3) |
| Match internal transfers by name/amount - IBAN only | names caused false positives |
| Run `eb resync` / `reclassify` in a loop; sync ~once a day | banks throttle PSD2 (429), and the local LLM is slow |
| Overwrite an existing account's type, or its name with the owner name from OB | keeps the type and name the owner chose (the OB owner name is a person's name, not an account name) |
| Read or write across vaults, or take a profile as an MCP tool argument | data of one profile must never show up in another |
| Edit a stored event or reuse an event type name | events are forever; change through a new version and an upcaster ([data-model.md](data-model.md) rule 15) |
| Commit anything from `data/` or `statements/` | real financial data (data-safety rule 1) |
| Create a real OS keychain item or touch the real data dir from a test or a dev run | only `cashu-next-test.*` keys and temp / demo data dirs |
| Use `useMemo` / `useCallback` / `memo` | the React Compiler memoizes; Biome bans them |
| Loosen an `arch:check` rule to get green | fix the cause the check names |

## See also

- [data-model.md](data-model.md) - domain rules
- [extending.md](extending.md) - recipes: module, screen, MCP tool, CLI command, store schema change, connector
- [running.md](running.md) - running, demo data, e2e
