/// <reference types="node" />
// The Electron shell itself: token bridge, navigation pin, single instance, sidecar bookkeeping,
// window screenshot. Runs on the same demo data dir as the dashboard specs.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, electronBinary, expect, launchEnv, readApiToken, test } from "../electron-test.ts";

test("the window shows the dashboard and gets the token through the bridge", async ({
  page,
  desktop,
}) => {
  await expect(page.getByRole("navigation", { name: "Moduły" })).toBeVisible();
  // The SPA keeps asking window.pywebview.api.token() (frontend/src/core/token.ts); the page never carries it.
  const token = await page.evaluate(() =>
    (
      window as unknown as { pywebview: { api: { token(): Promise<string | null> } } }
    ).pywebview.api.token(),
  );
  expect(token).toBe(readApiToken(desktop.dataDir));
  expect(page.url()).not.toContain("token=");
  expect(await page.content()).not.toContain(token as string);
  const withoutToken = await page.request.get(`${desktop.origin}/api/p/demo-anna/overview`);
  expect(withoutToken.status()).toBe(401);
  const withToken = await page.request.get(`${desktop.origin}/api/profiles`, {
    headers: { "X-Cashu-Token": token as string },
  });
  expect(withToken.ok()).toBeTruthy();
});

test("a foreign window never gets the token", async ({ desktop }) => {
  const answer = await desktop.app.evaluate(
    async ({ BrowserWindow }, preload) => {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { preload, sandbox: true, contextIsolation: true },
      });
      await win.loadURL("data:text/html,<p>foreign</p>");
      const result = await win.webContents.executeJavaScript("window.pywebview.api.token()");
      win.destroy();
      return result;
    },
    join(appDir(), "dist", "preload.cjs"),
  );
  expect(answer).toBeNull();
});

test("the window stays on the app origin", async ({ page, desktop }) => {
  await page.evaluate(() => {
    location.href = "file:///etc/hosts";
  });
  await page.evaluate(() => window.open("javascript:void(0)"));
  await page.waitForTimeout(500);
  expect(page.url().startsWith(desktop.origin)).toBe(true);
  expect(await page.evaluate(() => document.title.length)).toBeGreaterThan(0);
});

test("the sidecar runs on the remembered port with the demo data", async ({ desktop }) => {
  const state = JSON.parse(readFileSync(join(desktop.dataDir, "desktop.json"), "utf8")) as {
    port: number;
  };
  expect(`http://127.0.0.1:${state.port}`).toBe(desktop.origin);
  const log = readFileSync(join(desktop.dataDir, "logs", "electron.log"), "utf8");
  expect(log).toContain("start: started");
  expect(log).not.toContain(readApiToken(desktop.dataDir));
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
  await page.waitForTimeout(1500);
  await page.screenshot({
    path: process.env.S35_SCREENSHOT ?? join(appDir(), "dist", "e2e-run", "window.png"),
  });
});
