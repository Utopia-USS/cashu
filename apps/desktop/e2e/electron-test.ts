/// <reference types="node" />
// The `page` of every test is the Electron window. One Electron app per worker (the specs run one
// after another), launched on the demo data dir the global setup seeded.
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { _electron, test as base, type ElectronApplication, type Page } from "@playwright/test";

export interface DesktopOptions {
  dataDir: string;
  /** Extra environment (isolation variables come from the global setup). */
  env?: Record<string, string>;
}

export function appDir(): string {
  const dir = process.env.E2E_APP_DIR;
  if (!dir) throw new Error("E2E_APP_DIR is not set (global setup did not run)");
  return dir;
}

export function electronBinary(): string {
  const bin = process.env.E2E_ELECTRON;
  if (!bin) throw new Error("E2E_ELECTRON is not set (global setup did not run)");
  return bin;
}

/** The environment of a shell launch: the lab/test isolation plus the offline sidecar. */
export function launchEnv(
  dataDir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("ELECTRON_")) env[key] = value;
  }
  return {
    ...env,
    CASHU_DATA_DIR: dataDir,
    CASHU_DESKTOP_ALLOWED_DATA_ROOT: process.env.E2E_ROOT ?? dataDir,
    CASHU_DESKTOP_SIDECAR_BIN: process.env.E2E_PYTHON ?? "",
    CASHU_DESKTOP_SIDECAR_ARGS: JSON.stringify([process.env.E2E_SERVE_OFFLINE ?? ""]),
    CASHU_LANG: "pl",
    TZ: "Europe/Warsaw",
    ...extra,
  };
}

export async function launchDesktop(options: DesktopOptions): Promise<ElectronApplication> {
  return _electron.launch({
    executablePath: electronBinary(),
    args: [appDir(), "--lang=pl-PL"],
    env: launchEnv(options.dataDir, options.env),
    timeout: 90_000,
  });
}

/** Resolves with the window once it shows the dashboard (not the loading page). */
export async function dashboardWindow(
  app: ElectronApplication,
): Promise<{ page: Page; origin: string }> {
  const page = await app.firstWindow();
  await page.waitForURL(/^http:\/\/127\.0\.0\.1:\d+\//, { timeout: 90_000 });
  return { page, origin: new URL(page.url()).origin };
}

export function readApiToken(dataDir: string): string {
  const file = join(dataDir, "api-token");
  if (!existsSync(file)) throw new Error(`no ${file}`);
  return readFileSync(file, "utf8").trim();
}

export interface Desktop {
  app: ElectronApplication;
  origin: string;
  dataDir: string;
  process: ChildProcess;
}

export const test = base.extend<{ page: Page }, { desktop: Desktop }>({
  desktop: [
    // biome-ignore lint/correctness/noEmptyPattern: Playwright requires a destructured first argument
    async ({}, use) => {
      const dataDir = process.env.E2E_DATA_DIR;
      if (!dataDir) throw new Error("E2E_DATA_DIR is not set (global setup did not run)");
      const app = await launchDesktop({ dataDir });
      const { origin } = await dashboardWindow(app);
      // The specs (and their own API calls) address the sidecar through these.
      process.env.E2E_BASE_URL = origin;
      process.env.E2E_TOKEN = readApiToken(dataDir);
      await use({ app, origin, dataDir, process: app.process() });
      await app.close().catch(() => {});
    },
    { scope: "worker", timeout: 180_000 },
  ],
  page: async ({ desktop }, use) => {
    const page = await desktop.app.firstWindow();
    // A fresh browser context per test in the Chrome flow: start from clean web storage here.
    await page.evaluate(() => {
      localStorage.clear();
      sessionStorage.clear();
    });
    await page.goto(`${desktop.origin}/`);
    await use(page);
  },
});

export { expect } from "@playwright/test";
export type { ElectronApplication, Page };
