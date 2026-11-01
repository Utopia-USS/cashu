/// <reference types="node" />
// The `page` of every test is the Electron window. One Electron app per worker (the specs run one
// after another), launched on the demo data dir the global setup seeded.
import { type ChildProcess, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { _electron, test as base, type ElectronApplication, type Page } from "@playwright/test";
import { build } from "rolldown";

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

/**
 * The API token, asked the way the SPA asks it: through the window's TRANSITIONAL(S55z) bridge. The
 * shell generates it and hands it to the sidecar over a pipe; no file or output carries it.
 */
export async function bridgeToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (
      window as unknown as { pywebview?: { api: { token(): Promise<string | null> } } }
    ).pywebview?.api.token(),
  );
  if (!token) throw new Error("the window's token bridge did not answer");
  return token;
}

/** The sidecar process of a shell: the child of the Electron main that runs the offline server. */
export function sidecarPids(electronPid: number): number[] {
  const r = spawnSync("pgrep", ["-P", String(electronPid), "-f", "serve_offline\\.py"], {
    encoding: "utf8",
  });
  return r.stdout.split("\n").filter(Boolean).map(Number);
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The page-side store harness (store-harness/renderer.ts) as one script to evaluate in the window. */
export async function storeHarnessScript(): Promise<string> {
  const out = await build({
    input: join(appDir(), "e2e", "store-harness", "renderer.ts"),
    platform: "browser",
    write: false,
    resolve: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
    output: { format: "iife" },
    logLevel: "warn",
  });
  const chunk = out.output[0];
  if (chunk.type !== "chunk") throw new Error("the harness bundle has no code");
  return chunk.code;
}

/** The pid in the data dir's host discovery file (`run/host.json`), or null when no host wrote one. */
export function hostPid(dataDir: string): number | null {
  const file = join(dataDir, "run", "host.json");
  if (!existsSync(file)) return null;
  const pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
  return typeof pid === "number" ? pid : null;
}

/** Waits until `check` holds (polling), or throws after `timeoutMs`. */
export async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/**
 * Stops the data dir's local host (started on demand, it outlives the window and lingers while idle):
 * SIGTERM (it drains, closes its stores, releases its lock), SIGKILL as the last resort.
 */
export async function stopHost(dataDir: string): Promise<void> {
  const pid = hostPid(dataDir);
  if (pid === null || !alive(pid)) return;
  process.kill(pid, "SIGTERM");
  try {
    await until(() => !alive(pid), 10_000);
  } catch {
    process.kill(pid, "SIGKILL");
    await until(() => !alive(pid), 5_000);
  }
}

export async function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => s.close(() => resolve(true)));
  });
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
      const { page, origin } = await dashboardWindow(app);
      // The specs (and their own API calls) address the sidecar through these.
      process.env.E2E_BASE_URL = origin;
      process.env.E2E_TOKEN = await bridgeToken(page);
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
