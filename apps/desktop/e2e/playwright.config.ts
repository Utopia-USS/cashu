// Playwright against the Electron window (`_electron`): the repo's e2e smoke specs plus the desktop
// specs, run on a temp demo data dir. Run: `pnpm --filter @cashu/desktop build && pnpm --filter @cashu/desktop e2e`
// (one spec: `pnpm --filter @cashu/desktop e2e 01-settings`). Needs the built SPA (frontend/ `npm run build`).
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { GENERATED, prepareSpecs } from "./prepare-specs.ts";

// Workers load this file again: only the main process (re)builds the tree.
const specs = process.env.TEST_WORKER_INDEX ? join(GENERATED, "specs") : prepareSpecs();

export default defineConfig({
  testDir: specs,
  outputDir: join(GENERATED, "results"),
  globalSetup: "./global-setup.ts",
  // One Electron app, one database: specs run one after another (some change the demo data).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
});
