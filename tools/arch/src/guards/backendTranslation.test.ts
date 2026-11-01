import { describe, expect, it } from "vitest";
import { listFiles, readRepoFile } from "../repo.ts";
import { ambientTranslationLines, isBackendTranslationFile } from "./backendTranslation.ts";

describe("backend translation import detector", () => {
  it.each([
    'import { tr } from "@cashu/i18n";',
    'import { tr as translate } from "@cashu/i18n";',
    'import { lang, setLanguage } from "@cashu/i18n";',
    'import { catalog as texts } from "@cashu/i18n";',
    'import { pinnedLang, intlLocale, inEveryLang, installLanguageSource } from "@cashu/i18n";',
    'import { futureAmbientHelper } from "@cashu/i18n";',
    'import { S } from "@cashu/i18n/budget/importSources.strings";',
    'import "@cashu/i18n";',
    'import "@cashu/i18n/budget/importSources.strings";',
    'import {\n tr as translate,\n type Translator\n} from "@cashu/i18n";',
    'import * as language from "@cashu/i18n";',
    'import language from "@cashu/i18n";',
    'export { tr as translate } from "@cashu/i18n";',
    'export { catalog as texts } from "@cashu/i18n";',
    'export { S } from "@cashu/i18n/budget/importSources.strings";',
    'export * from "@cashu/i18n";',
    'export * as language from "@cashu/i18n";',
    'const language = await import("@cashu/i18n");',
    'const { tr: translate } = require("@cashu/i18n");',
    'const { S } = require("@cashu/i18n/budget/importSources.strings");',
    'const language = await import("@cashu/i18n/budget/importSources.strings");',
    'import language = require("@cashu/i18n");',
    "const language = await import(`@cashu/i18n`);",
  ])("rejects ambient access: %s", (source) => {
    expect(ambientTranslationLines(source)).toEqual([1]);
  });

  it.each([
    'import type { Translator } from "@cashu/i18n";',
    'import { type Translator, createTranslator, parseLang, plCount } from "@cashu/i18n";',
    'import type * as LanguageTypes from "@cashu/i18n";',
    'export type { Translator } from "@cashu/i18n";',
    'export { createTranslator } from "@cashu/i18n";',
    'import { createTranslator as tr } from "@cashu/i18n";',
    'import { createBackendI18n, LANG_ENV, LANG_HEADER, LANGS, FALLBACK_LANG, matchLang } from "@cashu/i18n";',
    'import { plForm, enForm, enCount, normalizeNumberInput } from "@cashu/i18n";',
    'export { normalizeNumberInput as parseAmount } from "@cashu/i18n";',
    'const text = "import { tr } from @cashu/i18n";',
    '// import { tr } from "@cashu/i18n";',
    "const tr = (value: string) => value;",
    'import { tr } from "another-package";',
  ])("allows explicit contexts, helpers and non-import text: %s", (source) => {
    expect(ambientTranslationLines(source)).toEqual([]);
  });

  it("reports stable source line numbers", () => {
    expect(
      ambientTranslationLines(
        '\nimport { tr as t } from "@cashu/i18n";\n\nexport * from "@cashu/i18n";',
      ),
    ).toEqual([2, 4]);
  });
});

describe("backend translation scope", () => {
  it.each([
    "packages/api/src/index.ts",
    "packages/mcp/src/handler.ts",
    "packages/store/src/core/commands.ts",
    "packages/sync/src/reader.ts",
    "packages/market/src/yahoo.ts",
    "apps/cli/src/index.ts",
    "apps/relay/src/index.ts",
    "apps/sync-daemon/src/index.ts",
    "apps/desktop/src/main.ts",
    "apps/desktop/src/preload.cts",
    "apps/desktop/src/hostRelay.ts",
  ])("covers %s", (file) => expect(isBackendTranslationFile(file)).toBe(true));

  it.each([
    "frontend/src/core/example.ts",
    "packages/ui-logic/src/core/example.ts",
    "packages/ui/src/Example.tsx",
    "packages/store-react/src/index.ts",
    "packages/i18n/src/tr.ts",
    "apps/desktop/src/renderer/screens/Example.tsx",
    "apps/mobile/src/screens/Example.tsx",
    "packages/api/src/example.test.ts",
    "apps/desktop/src/preload.test.cts",
    "packages/mcp/src/testing/example.ts",
  ])("leaves UI and test-only code outside: %s", (file) =>
    expect(isBackendTranslationFile(file)).toBe(false),
  );
});

describe("guard: backend uses request/run translators", () => {
  const files = listFiles(["packages", "apps"], /\.[cm]?[jt]sx?$/).filter(isBackendTranslationFile);

  it(`no ambient translation import in ${files.length} backend files`, () => {
    const hits = files.flatMap((file) =>
      ambientTranslationLines(readRepoFile(file), file).map((line) => `${file}:${line}`),
    );
    expect(
      hits,
      `Backend code must take an immutable Translator and use context.tr(). Named imports of
types and reviewed pure root helpers are allowed. All other runtime exports, catalog subpaths and
namespace/dynamic/CommonJS access are forbidden here (packages/i18n/README.md):\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
