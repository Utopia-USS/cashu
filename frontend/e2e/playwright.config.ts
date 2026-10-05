// e2e smoke suite: Playwright test runner with the system Chrome (no browser download). The global setup
// seeds a temp data dir with scripts/demo_data.py and starts `finanse serve` (offline market sources) on
// a free port; every spec opens the printed #token= URL. Artifacts stay in e2e/output/ (gitignored).
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  outputDir: "./output/results",
  globalSetup: "./global-setup.ts",
  // One server, one database: specs run one after another (some change the demo data).
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { outputFolder: "./output/report", open: "never" }]],
  use: {
    channel: "chrome",
    headless: true,
    locale: "pl-PL",
    timezoneId: "Europe/Warsaw",
    viewport: { width: 1360, height: 900 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
