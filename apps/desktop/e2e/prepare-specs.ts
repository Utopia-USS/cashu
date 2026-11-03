/// <reference types="node" />
// Builds the spec tree Playwright runs: the repo's browser smoke specs (frontend/e2e/specs, unmodified
// on disk) adapted to run against the Electron window, plus this package's own desktop specs.
//
// The adaptation is mechanical and fails loudly when the frontend files change shape:
//  - specs: `import.meta.url` is replaced by the original spec's file URL, so every path a spec
//    derives from its own location (REPO, HERE, fixtures) still points into frontend/e2e;
//  - fixtures.ts: `test` comes from ./electron-test (page = the Electron window) and `openApp`
//    opens the app root without a #token= fragment, so the window's own token bridge is what
//    authenticates every test.
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const APP_DIR = resolve(HERE, "..");
export const REPO = resolve(APP_DIR, "..", "..");
const FRONTEND_E2E = join(REPO, "frontend", "e2e");
/** Generated, git-ignored (dist/). */
export const GENERATED = join(APP_DIR, "dist", "e2e-run");

function replaceOnce(text: string, from: string, to: string, what: string): string {
  if (!text.includes(from))
    throw new Error(`frontend e2e changed: cannot adapt ${what} (missing: ${from})`);
  return text.replace(from, () => to);
}

export function prepareSpecs(): string {
  rmSync(GENERATED, { recursive: true, force: true });
  const specs = join(GENERATED, "specs");
  mkdirSync(specs, { recursive: true });

  for (const name of readdirSync(join(FRONTEND_E2E, "specs"))) {
    if (!name.endsWith(".spec.ts")) continue;
    const source = join(FRONTEND_E2E, "specs", name);
    const text = readFileSync(source, "utf8").replaceAll(
      "import.meta.url",
      JSON.stringify(pathToFileURL(source).href),
    );
    writeFileSync(join(specs, name), text);
  }

  let fixtures = readFileSync(join(FRONTEND_E2E, "fixtures.ts"), "utf8");
  fixtures = replaceOnce(
    fixtures,
    'import { expect, test as base, type Locator, type Page } from "@playwright/test";',
    'import { expect, type Locator, type Page } from "@playwright/test";\nimport { test as base } from "./electron-test";',
    "fixtures.ts import",
  );
  // The strings are source text to match and replace, not templates.
  const gotoWithToken =
    "await page.goto(`$" + "{serverUrl()}/#token=$" + "{process.env.E2E_TOKEN}`);";
  const gotoRoot = "await page.goto(`$" + "{serverUrl()}/`);";
  fixtures = replaceOnce(fixtures, gotoWithToken, gotoRoot, "fixtures.ts openApp");
  writeFileSync(join(GENERATED, "fixtures.ts"), fixtures);
  cpSync(join(HERE, "electron-test.ts"), join(GENERATED, "electron-test.ts"));
  cpSync(join(HERE, "synthetic-host.ts"), join(GENERATED, "synthetic-host.ts"));
  cpSync(join(HERE, "strategies-support.ts"), join(GENERATED, "strategies-support.ts"));
  cpSync(join(HERE, "review-support.ts"), join(GENERATED, "review-support.ts"));
  cpSync(join(HERE, "desktop-specs"), specs, { recursive: true });
  return specs;
}
