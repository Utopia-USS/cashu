# Language contexts

The UI uses `lang()`, `catalog()` and `tr({ pl, en })` from `@cashu/i18n` with its installed
`LanguageSource` (S33). Backend work uses an explicit `Translator` (S34). Never change the UI's
global language to service a request: two requests can overlap across an `await`.

`pnpm arch:check` enforces this in API, MCP, store, sync and market packages, CLI/host/relay/sync workers and
Electron main/preload/utility code. Backend runtime imports/re-exports have an explicit allowlist:
`createTranslator`, `createBackendI18n`, `parseLang`, `LANG_ENV`, `LANG_HEADER`, `LANGS`, `FALLBACK_LANG`,
`matchLang`, `plCount`, `plForm`, `enCount`, `enForm` and `normalizeNumberInputForLanguage`. Type-only root imports
are allowed too. All other runtime exports (including `lang`, `setLanguage`, `catalog` and `tr`), UI
catalog subpaths, side-effect imports and namespace/dynamic/CommonJS access are rejected. New helpers
need an explicit purity review before joining this list. Renderer, UI logic and legacy frontend code
retain the ambient UI helpers. Test-only files are outside this production rule.

Backend number input uses `normalizeNumberInputForLanguage(text, context.language)`. The existing
`normalizeNumberInput(text)` is a thin UI wrapper reading `lang()` and is forbidden in backend code.
The guard's regression test follows every allowlisted export's local symbol dependencies and rejects
any path to the mutable UI language state, including reads hidden behind another helper.

## App and request language

Create one `createBackendI18n(source)` per settings location at the app composition root.
`BackendLanguageSource` is the platform seam; the i18n package imports no Node, DOM, Expo or
framework APIs. The adapter reads:

- `environmentLanguage()`: `CASHU_LANG`, if present.
- `storedLanguage()`: the `language` field from `settings.json`; missing / malformed files mean null.
- `osLanguage()`: the first supported OS preference, or the effective locale environment value.
  BackendI18n memoizes this lazily for its lifetime, including an unsupported / missing language;
  an adapter shared across instances may memoize it for the process lifetime, like Python's cache.
  A Node adapter follows Python: macOS AppleLanguages first; otherwise the first nonempty LC_ALL,
  LC_MESSAGES, LANG value (an unsupported effective locale means no match).
- `rememberLanguage(language)`: atomically update only that settings field, preserving other keys
  and private file permissions. This callback must complete synchronously, like the existing
  platform source and Python middleware. It must not return an unawaited persistence promise.

`appLanguage()` re-reads the environment override and stored choice, then uses the cached OS choice
and finally English, in that order. It does not cache a worker's effective language forever.

At the HTTP / websocket boundary, preserve raw header lines. For a Node `IncomingMessage` adapter:

```ts
import { LANG_HEADER } from "@cashu/i18n";

const context = backendI18n.forRequest(nodeRequest.headersDistinct[LANG_HEADER]);
return handleRequest(context);
```

`forRequest` accepts one raw string or an array of raw values in wire order. It takes the first raw
line, matching Python's `Headers.get`, then normalizes it (`en-GB`, `pl_PL.UTF-8`, etc.). Two raw lines
`["pl", "en"]` select Polish, while the single line `"pl, en"` is invalid and uses the app language.
A Fetch getter joins duplicates, so its string cannot distinguish those cases: capture the raw
values in the host adapter before constructing a Fetch request, never reconstruct them by splitting
commas. A valid value is remembered for the worker
and returns an immutable context. A request header outranks even CASHU_LANG, matching Python's
request ContextVar. Missing / invalid headers use `appLanguage()` without writing. Consecutive
identical header choices do not cause repeated writes. Failed reads use the next fallback;
failed writes never fail a request and are retried on the next valid request. The remembered-write
cache is scoped to this instance / settings location.

Workers snapshot `createTranslator(backendI18n.appLanguage())` once at run start. MCP snapshots
`createTranslator("pl")`, regardless of app / request language. These contexts never write settings
or touch the UI's global language, including on errors or across awaits.

## Mechanical module port

Translate Python `tr(pl=..., en=...)` to `context.tr({ pl: ..., en: ... })`; pass `Translator`
explicitly through helpers. It selects any value (text, tuple, function, object) without changing
its identity. For a helper that calls `lang()`, read `context.language`. Python `use_language(x)`
becomes a new lexical `createTranslator(x)`, passed only to work in that scope.

Keep repeated/static variants in the module's `*.strings.ts` catalog when that module is ported:

```ts
// Example.strings.ts, in the module's own scope
import type { TranslationVariants } from "@cashu/i18n";
export const title = { pl: "Tytuł", en: "Title" } satisfies TranslationVariants<string>;

// The module's pure renderer
import type { Translator } from "@cashu/i18n";
import { title } from "./Example.strings.js";
export function renderTitle(context: Translator): string {
  return context.tr(title);
}
```

Do not use the UI's global `catalog()` getters in backend contexts. Modules with existing Polish
identity fields keep those fields for MCP / matching and resolve display variants through the
context at read time. User-entered / stored prose stays unchanged. Stable message codes and params
stay data; only the display text is translated. S34 supplies the runtime and pattern; moving macro,
alerts, notification and other module texts belongs to their module scopes.

## Verification

`src/tr.test.ts` translates every case of `tests/test_i18n.py` (the HTTP framework boundary becomes
an explicit request context). Its explicit Polish-run test covers only the translator prerequisite
of `tests/test_i18n_core_modules.py::test_mcp_output_stays_polish_with_an_english_app_language`;
the actual MCP host invocation and category redaction assertion belong to S38, whose host is not
implemented yet. This is not MCP integration coverage.
Extra cases cover simultaneous PL/EN requests, adapter errors and write retries, separate settings
locations, untrusted headers and generic values. `lang.test.ts` and `plural.test.ts` keep the S33
catalog/UI and plural contract. `backendModules.test.ts` ports the existing core registry, institution,
module, profile and taxonomy assertions from the Python module-label oracle. Category display passes
the context's language explicitly; the default lookup and stored label stay Polish. English-key
coverage, unknown-key passthrough and the English cash-withdrawal label are asserted directly.

The budget import service's `format_name()` / `importer_choices()` has no TypeScript producer yet.
It must be tested when that service is ported; a UI catalog with a similarly named investment-import
label is not a substitute. HTTP setup/import errors, notifications and boot pages likewise stay
with their actual adapters. S39 must test language on real CLI command execution; this runtime
does not yet expose those commands. Stable warning-code assertions already live with the domain
import contract and are not duplicated here behind a language loop.
