import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dashboardWindow,
  expect,
  launchDesktop,
  rewriteHash,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";
import { seedNativeStrategyDocuments } from "../strategies-support.ts";

test("native Strategies reads actual generated files, virtualizes source and suppresses prose in privacy mode", async () => {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("native generated demo is absent");
  await restoreNativeBaseline(dataDir);
  await seedNativeStrategyDocuments(dataDir);
  const host: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      join(repo, "tools/node-ts/resolveTs.ts"),
      join(repo, "apps/host/src/testing/seedOverviewDemo.ts"),
      "serve",
    ],
    { env: process.env, stdio: ["ignore", "ignore", "pipe"] },
  );
  let errors = "";
  host.stderr?.on("data", (chunk) => {
    errors += String(chunk);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    await until(
      () =>
        (existsSync(join(dataDir, "overview-ready")) &&
          readFileSync(join(dataDir, "overview-ready"), "utf8").trim() === String(host.pid)) ||
        host.exitCode !== null,
    );
    expect(host.exitCode, errors).toBeNull();
    app = await launchDesktop({ dataDir });
    const { page } = await dashboardWindow(app);
    await setPrivacy(page, false);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await rewriteHash(page, /\/overview(?:\?.*)?$/u, "/investments.strategies");
    await expect(page.getByTestId("native-strategies")).toBeVisible();
    await page.getByRole("button", { name: "Synthetic reference", exact: true }).click();
    await expect(page.getByText("Read-only reference prose.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "safe", exact: true })).toHaveAttribute(
      "href",
      "https://example.test",
    );
    await expect(page.getByRole("link", { name: "blocked", exact: true })).toHaveCount(0);
    await expect(page.locator("script").filter({ hasText: "synthetic()" })).toHaveCount(0);
    await page.getByRole("button", { name: "notes.yaml", exact: true }).click();
    await expect(
      page.getByText("Ten YAML jest dokumentem i nie jest wykonywany.", { exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "empty.txt", exact: true }).click();
    await expect(page.getByText("Plik jest pusty.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "long.txt", exact: true }).click();
    const source = page.getByRole("region", { name: "Źródło", exact: true });
    await expect(source).toContainText("synthetic line 1");
    await source.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(source).toContainText("synthetic line 140");
    expect(await source.locator("pre").count()).toBeLessThan(50);
    await setPrivacy(page, true);
    await expect(page.getByText("Synthetic reference", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Synthetic private description", { exact: true })).toHaveCount(0);
    await setPrivacy(page, false);
    await expect(page.getByTestId("native-strategies")).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Synthetic reference", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Synthetic reference", exact: true }).click();
    await expect(page.getByText("Read-only reference prose.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "strategy.yaml", exact: true }).click();
    await page.getByRole("button", { name: "Wczytaj strategię", exact: true }).click();
    await expect(page.getByTestId("native-strategies").getByRole("status")).toContainText(
      /Wczytano i zapisano wersję\.|Pliki nie zmieniły się\./,
    );
    await page.screenshot({ path: join(dataDir, "native-strategies.png"), fullPage: true });
  } finally {
    if (app) {
      await app.close().catch(() => {});
      await stopHost(dataDir).catch(() => {});
    }
    if (host.exitCode === null) {
      host.kill("SIGTERM");
      await until(() => host.exitCode !== null);
    }
  }
});
