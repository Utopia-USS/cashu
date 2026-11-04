/// <reference types="node" />
// Shared native Electron helpers. Every launch is bound to an isolated synthetic data root.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _electron, type ElectronApplication, expect, type Page, test } from "@playwright/test";
import { build } from "rolldown";

export interface DesktopOptions {
  dataDir: string;
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

export function launchEnv(
  dataDir: string,
  extra: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env))
    if (value !== undefined && !key.startsWith("ELECTRON_")) env[key] = value;
  return {
    ...env,
    CASHU_DATA_DIR: dataDir,
    CASHU_DESKTOP_ALLOWED_DATA_ROOT: process.env.E2E_ROOT ?? dataDir,
    CASHU_DESKTOP_NO_TRAY: "1",
    CASHU_LANG: "pl",
    TZ: "Europe/Warsaw",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
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

export async function dashboardWindow(
  app: ElectronApplication,
): Promise<{ page: Page; origin: string }> {
  const page = await app.firstWindow();
  await page.waitForURL(/^app:\/\/cashu\//, { timeout: 90_000 });
  return { page, origin: "app://cashu" };
}

/**
 * The real shell behind host-spawn-guard.cjs: main cannot spawn any child (no host, no migration),
 * so the spec's own synthetic host is the only one. The private app dir sits beside the data dir.
 */
export async function launchGuardedDesktop(options: DesktopOptions): Promise<ElectronApplication> {
  const appPath = `${options.dataDir}-guard-app`;
  mkdirSync(appPath, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(appPath, "package.json"),
    JSON.stringify({ name: "cashu-guarded-e2e", private: true, main: "bootstrap.cjs" }),
    { mode: 0o600 },
  );
  writeFileSync(
    join(appPath, "bootstrap.cjs"),
    readFileSync(join(appDir(), "e2e", "host-spawn-guard.cjs")),
    { mode: 0o600 },
  );
  return _electron.launch({
    executablePath: electronBinary(),
    args: [appPath, "--lang=pl-PL"],
    env: launchEnv(options.dataDir, {
      E2E_GUARD_DATA_DIR: options.dataDir,
      E2E_GUARD_MAIN: join(appDir(), "dist", "main.js"),
      ...options.env,
    }),
    timeout: 90_000,
  });
}

/** A real shell click, followed by React's settled state after possible Suspense rebind. */
export async function setPrivacy(page: Page, hidden: boolean): Promise<void> {
  const checkbox = page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true });
  if ((await checkbox.isChecked()) !== hidden) await checkbox.click();
  if (hidden) await expect(checkbox).toBeChecked();
  else await expect(checkbox).not.toBeChecked();
}

/**
 * Waits until no modal is open and a closed modal's history entry is gone. A modal (packages/ui
 * Modal) pushes an entry when it opens and, a task after it closes, calls `history.back()`; that
 * traversal is async, so a route change made in between is undone by it (the window lands back on
 * the modal's route). A marker left on an entry that no back will remove is waited out (1 s).
 */
export async function settleModalHistory(page: Page): Promise<void> {
  await page.waitForFunction(
    () => document.querySelector("[data-cashu-modal-panel]") === null,
    undefined,
    { timeout: 10_000 },
  );
  await page.evaluate(async () => {
    if ((history.state as { cashuModal?: unknown } | null)?.cashuModal === undefined) return;
    await new Promise<void>((resolve) => {
      const done = () => {
        window.removeEventListener("popstate", done);
        resolve();
      };
      window.addEventListener("popstate", done);
      setTimeout(done, 1_000);
    });
  });
}

/** Rewrites the window's hash route like a pasted link, after any closing modal let go of it. */
export async function rewriteHash(page: Page, from: RegExp, to: string): Promise<void> {
  // EXPERIMENT await settleModalHistory(page);
  await page.evaluate(
    ([source, flags, replacement]) => {
      const next = new URL(location.href);
      next.hash = next.hash.replace(new RegExp(source, flags), replacement);
      location.assign(next.href);
    },
    [from.source, from.flags, to] as const,
  );
}

/** An own-origin page with no production client; injected port tests own the frame's sole relay. */
export async function storeHarnessWindow(app: ElectronApplication): Promise<Page> {
  const { page } = await dashboardWindow(app);
  await page.goto("app://cashu/assets/desktop/e2e-store.html");
  await page.getByRole("heading", { name: "Native store test" }).waitFor();
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { cashuStoreHarness?: unknown }).cashuStoreHarness ===
      "function",
  );
  return page;
}

/** Bundle the test-only store client as a same-origin app-protocol script. */
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

export function hostPid(dataDir: string): number | null {
  const file = join(dataDir, "run", "host.json");
  if (!existsSync(file)) return null;
  const pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid;
  return typeof pid === "number" ? pid : null;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("condition not reached in time");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

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

export type { ElectronApplication, Page };
export { expect, test };
