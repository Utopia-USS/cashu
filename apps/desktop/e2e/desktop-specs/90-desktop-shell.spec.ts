/// <reference types="node" />
// The Electron shell itself: token bridge, navigation pin, single instance, sidecar bookkeeping,
// window screenshot. Runs on the same demo data dir as the dashboard specs.
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, bridgeToken, electronBinary, expect, launchEnv, test } from "../electron-test.ts";

test("the window shows the dashboard and gets the token through the bridge", async ({
  page,
  desktop,
}) => {
  await expect(page.getByRole("navigation", { name: "Moduły" })).toBeVisible();
  // The SPA keeps asking window.pywebview.api.token() (frontend/src/core/token.ts); the page never
  // carries it, and the shell generated it: no api-token file, nothing in the sidecar's output.
  const token = await bridgeToken(page);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(token).toBe(process.env.E2E_TOKEN);
  expect(existsSync(join(desktop.dataDir, "api-token"))).toBe(false);
  expect(page.url()).not.toContain("token=");
  expect(await page.content()).not.toContain(token);
  const withoutToken = await page.request.get(`${desktop.origin}/api/p/demo-anna/overview`);
  expect(withoutToken.status()).toBe(401);
  const withToken = await page.request.get(`${desktop.origin}/api/health`, {
    headers: { "X-Cashu-Token": token },
  });
  expect(withToken.ok()).toBeTruthy();
});

test("a foreign window gets neither the pywebview shim nor the token", async ({ desktop }) => {
  const answer = await desktop.app.evaluate(
    async ({ BrowserWindow }, preload) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true },
      });
      await win.loadURL("data:text/html,<p>foreign</p>");
      const result = await win.webContents.executeJavaScript(
        "({ shim: typeof window.pywebview, inWindow: 'pywebview' in window })",
      );
      win.destroy();
      return result;
    },
    join(appDir(), "dist", "preload.cjs"),
  );
  expect(answer).toEqual({ shim: "undefined", inWindow: false });
});

test("the shim exists only on the app's own page of the window", async ({ page, desktop }) => {
  expect(await page.evaluate(() => "pywebview" in window)).toBe(true);
  // The same window on another page (an about:blank document): the preload exposes nothing.
  await page.goto("about:blank");
  expect(await page.evaluate(() => "pywebview" in window)).toBe(false);
  await page.goto(`${desktop.origin}/`);
  expect(await page.evaluate(() => "pywebview" in window)).toBe(true);
});

test("the window stays on the app origin", async ({ page, desktop }) => {
  // Watch the main process decide (a listener after the shell's own sees its verdict), instead of
  // waiting a fixed time and hoping nothing happened.
  await desktop.app.evaluate(({ BrowserWindow }) => {
    const seen: { url: string; prevented: boolean }[] = [];
    (globalThis as { __navigations?: typeof seen }).__navigations = seen;
    BrowserWindow.getAllWindows()[0]?.webContents.on("will-navigate", (event, url) => {
      seen.push({ url, prevented: event.defaultPrevented });
    });
  });
  // file: from an http page is refused by Chromium itself, before the shell is asked.
  await page.evaluate(() => {
    location.href = "file:///etc/hosts";
  });
  // A scheme no handler owns reaches the shell's will-navigate and is dropped there.
  await page.evaluate(() => {
    location.href = "cashu-e2e-nowhere://x";
  });
  await expect
    .poll(() =>
      desktop.app.evaluate(
        () =>
          (globalThis as { __navigations?: { url: string; prevented: boolean }[] }).__navigations,
      ),
    )
    .toContainEqual({ url: "cashu-e2e-nowhere://x", prevented: true });
  // A denied window.open returns null synchronously: no second window.
  expect(await page.evaluate(() => window.open("javascript:void(0)") === null)).toBe(true);
  expect(desktop.app.windows()).toHaveLength(1);
  expect(page.url().startsWith(desktop.origin)).toBe(true);
  await expect(page.getByRole("navigation", { name: "Moduły" })).toBeVisible();
});

test("the sidecar runs on the remembered port with the demo data", async ({ desktop }) => {
  const state = JSON.parse(readFileSync(join(desktop.dataDir, "desktop.json"), "utf8")) as {
    port: number;
  };
  expect(`http://127.0.0.1:${state.port}`).toBe(desktop.origin);
  const log = readFileSync(join(desktop.dataDir, "logs", "electron.log"), "utf8");
  expect(log).toContain("start: started");
  expect(log).not.toContain(process.env.E2E_TOKEN ?? "<none>");
  expect(log).not.toContain("GET /api");
});

test("a second launch is refused, fronts the first window and hands it a link", async ({
  page,
  desktop,
}) => {
  const second = spawn(electronBinary(), [appDir(), "--open-link=cashu://investments/demo-anna"], {
    env: launchEnv(desktop.dataDir),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  second.stderr.on("data", (c: Buffer) => {
    output += c.toString();
  });
  const code = await new Promise<number | null>((done) => {
    const timer = setTimeout(() => {
      second.kill("SIGKILL");
      done(null);
    }, 30_000);
    second.once("exit", (c) => {
      clearTimeout(timer);
      done(c);
    });
  });
  expect(code).toBe(0);
  expect(output).toContain("już otwarty");
  await expect(page).toHaveURL(/#\/demo-anna\/investments\.portfolio/);
  expect(desktop.app.process().exitCode).toBeNull();
});

test("window screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 1480, height: 940 }).catch(() => {});
  await expect(page.getByRole("navigation", { name: "Moduły" })).toBeVisible();
  await page.evaluate(() => {
    location.hash = "#/demo-anna/overview";
  });
  // The overview has rendered its figures (the card frontend/e2e/specs/03-month-close reads).
  await expect(page.getByText(/^na inwestycje .+ po poduszce$/)).toBeVisible();
  await page.screenshot({
    path: process.env.S35_SCREENSHOT ?? join(appDir(), "dist", "e2e-run", "window.png"),
  });
});
