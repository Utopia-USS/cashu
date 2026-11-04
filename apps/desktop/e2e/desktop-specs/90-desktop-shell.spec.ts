import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDir, dashboardWindow, expect, launchDesktop, test } from "../electron-test.ts";
import { nativeCreationHarness } from "../native-creation-support.ts";

test("native startup exposes only its own-origin bridges and pins navigation", async () => {
  const harness = nativeCreationHarness();
  try {
    const host = await harness.startHost();
    const app = await harness.launchDesktop();
    const { page, origin } = await dashboardWindow(app);
    expect(origin).toBe("app://cashu");
    await expect(page.getByTestId("native-creation")).toBeVisible();
    expect(
      await page.evaluate(() => ({
        creation: "cashuCreation" in window,
        shim: "pywebview" in window,
      })),
    ).toEqual({ creation: true, shim: false });
    expect(page.url()).not.toContain("token=");
    expect(existsSync(join(harness.dataDir, "api-token"))).toBe(false);
    const foreign = await app.evaluate(
      async ({ BrowserWindow }, preload) => {
        const win = new BrowserWindow({
          show: false,
          webPreferences: { preload, sandbox: true, contextIsolation: true },
        });
        await win.loadURL("data:text/html,<p>foreign</p>");
        const seen = await win.webContents.executeJavaScript(
          "({ creation: 'cashuCreation' in window, service: 'cashuService' in window, shim: 'pywebview' in window })",
        );
        win.destroy();
        return seen;
      },
      join(appDir(), "dist", "preload.cjs"),
    );
    expect(foreign).toEqual({ creation: false, service: false, shim: false });
    await app.evaluate(({ BrowserWindow }) => {
      const seen: { url: string; prevented: boolean }[] = [];
      (globalThis as { __nativeNavigations?: typeof seen }).__nativeNavigations = seen;
      BrowserWindow.getAllWindows()[0]?.webContents.on("will-navigate", (event, url) =>
        seen.push({ url, prevented: event.defaultPrevented }),
      );
    });
    await page.evaluate(() => {
      location.href = "cashu-e2e-nowhere://x";
    });
    await expect
      .poll(() =>
        app.evaluate(
          () =>
            (globalThis as { __nativeNavigations?: { url: string; prevented: boolean }[] })
              .__nativeNavigations,
        ),
      )
      .toContainEqual({ url: "cashu-e2e-nowhere://x", prevented: true });
    expect(page.url().startsWith("app://cashu/")).toBe(true);
    expect(await page.evaluate(() => window.open("javascript:void(0)") === null)).toBe(true);
    expect(app.windows()).toHaveLength(1);
    await host.stop();
  } finally {
    await harness.cleanup();
  }
});

test("a legacy database shows migration admission without opening a native store", async () => {
  const root = process.env.E2E_ROOT;
  if (!root) throw new Error("isolated root is absent");
  const dataDir = join(root, "legacy-admission");
  mkdirSync(dataDir, { mode: 0o700 });
  writeFileSync(join(dataDir, "cashu.db"), "synthetic sentinel", { mode: 0o600 });
  const app = await launchDesktop({ dataDir });
  try {
    const { page } = await dashboardWindow(app);
    await expect(page.getByTestId("native-creation")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Dane wymagają sprawdzenia" })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("Wykryto dane z poprzedniej wersji");
    expect(await page.evaluate(() => "pywebview" in window)).toBe(false);
    expect(existsSync(join(dataDir, "stores"))).toBe(false);
  } finally {
    await app.close().catch(() => {});
  }
});
