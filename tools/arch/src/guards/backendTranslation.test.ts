import { describe, expect, it } from "vitest";
import { listFiles, readRepoFile } from "../repo.ts";
import { ambientTranslationLines, isBackendTranslationFile } from "./backendTranslation.ts";

describe("backend translation import detector", () => {
  it.each([
    'import { tr } from "@cashu/i18n";',
    'import { tr as translate } from "@cashu/i18n";',
    'import {\n tr as translate,\n type Translator\n} from "@cashu/i18n";',
    'import * as language from "@cashu/i18n";',
    'import language from "@cashu/i18n";',
    'export { tr as translate } from "@cashu/i18n";',
    'export * from "@cashu/i18n";',
    'export * as language from "@cashu/i18n";',
    'const language = await import("@cashu/i18n");',
    'const { tr: translate } = require("@cashu/i18n");',
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
    'const text = "import { tr } from @cashu/i18n";',
    '// import { tr } from "@cashu/i18n";',
    "const tr = (value: string) => value;",
    'import { tr } from "another-package";',
    'import "@cashu/i18n";',
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

  it(`no ambient tr import in ${files.length} backend files`, () => {
    const hits = files.flatMap((file) =>
      ambientTranslationLines(readRepoFile(file), file).map((line) => `${file}:${line}`),
    );
    expect(
      hits,
      `Backend code must take an immutable Translator and use context.tr(). Named imports of
Translator/createTranslator and pure helpers are allowed. Root tr and namespace/dynamic/CommonJS root
imports expose the UI's global language and are forbidden here (packages/i18n/README.md):\n${hits.join("\n")}`,
    ).toEqual([]);
  });
});
