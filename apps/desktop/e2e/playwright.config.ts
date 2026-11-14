// Playwright against the native Electron window and synthetic local host.
// Run: `pnpm --filter @cashu/desktop build && pnpm --filter @cashu/desktop e2e`.
import { join } from "node:path";
import { defineConfig } from "@playwright/test";
import { GENERATED, prepareSpecs } from "./prepare-specs.ts";

const specs = prepareSpecs();

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
