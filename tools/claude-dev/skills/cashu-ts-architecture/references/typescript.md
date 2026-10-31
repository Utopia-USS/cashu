---
title: TypeScript, money, ids and errors
impact: HIGH
tags: typescript, types, decimal, errors, naming
---

# TypeScript, money, ids and errors

## Strictness

- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` (where the package enables it).
- No `any`, no `as` casts except at a validated boundary (after zod) or in tests. No non-null `!`
  outside tests.
- `readonly` arrays and properties for data crossing layers.
- Exhaustive `switch` over unions with an `assertNever(x)` default.

## Ids

Branded string types per entity (`type AccountGid = Brand<string, "AccountGid">`), created only by
the gid functions of the store or by zod decoding. Never pass a bare `string` where a gid is meant.
Integer ids from the Python era exist only inside parity tooling.

## Money and numbers

- `Money = { amount: Decimal; currency: CurrencyCode }` from `@cashu/domain`. Arithmetic through the
  money helpers, which refuse mixed currencies. Aggregations return `Map<CurrencyCode, Decimal>`.
- `number` only for counts, indexes, durations and the float-based analytics the Python code also
  computes in float (performance ratios), with the tolerance documented in parity.
- Decimal to string only through the canonical function (Python `str(Decimal)` compatible).

## React idioms under the React Compiler

- Write plain code: no `useMemo` / `useCallback` / `memo` (Biome bans the imports and `React.x`).
  A measured exception is `// biome-ignore lint/style/noRestrictedImports: <profiler evidence>` on the
  import, reviewed like any other suppression.
- Destructure what you call from hook results (`const { run, isPending } = useCommand(...)`) so the
  compiler can track it; do not mutate props, state or values read during render.
- Components are defined at module level, never inside another component.
- ESLint `react-hooks` (with the compiler diagnostics) must be clean: a compiler bail-out is an error.

## Boundaries

zod at every trust boundary: events read from the log, files and CSVs, MCP tool input, HTTP input,
settings on disk. Inside the boundary, plain types; do not re-validate.

## Errors

- Expected outcomes: return a union, e.g. `{ ok: true; value } | { ok: false; reason: "duplicate" | "not_found" }`.
- Suppressions (`biome-ignore`, `eslint-disable`, `@ts-expect-error`) always carry the reason; an
  unused directive is itself an error. A suppression is never the way to get a gate green.
- Bugs and broken invariants: `throw new InvariantError(...)`. Never throw strings.
- Never log secrets, keys, IBANs, names or amounts; loggers take structured fields and the shared
  redaction applies.

## Naming and files

- Files: `camelCase.ts` for modules, `PascalCase.tsx` for components, `useX.ts` for hooks,
  `X.strings.ts` for catalogs, `X.test.ts` and `X.stories.tsx` next to the code.
- Functions are verbs (`matchTransfers`), types are nouns, booleans read as questions (`isLeader`).
- One concept per file; a file over ~300 lines is a signal to split by responsibility.
- Comments explain why, in English; no commented-out code.
