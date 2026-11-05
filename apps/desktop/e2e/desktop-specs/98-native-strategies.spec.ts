import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  dashboardWindow,
  expect,
  launchDesktop,
  pickProfile,
  rewriteHash,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";
import { seedNativeStrategyDocuments } from "../strategies-support.ts";

test("native Strategies reads actual generated files in the Python layout and suppresses prose in privacy mode", async () => {
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
    await pickProfile(page, "Demo Anna");
    await rewriteHash(page, /\/overview(?:\?.*)?$/u, "/investments.strategies");
    await expect(page.getByTestId("native-strategies")).toBeVisible();
    // The tree (old `.strat-tree` nav): a document button holds its title, tags and description; a file
    // button its kind badge (MD / YML / TXT) before the name.
    const tree = page.getByRole("navigation", { name: "Strategie i ich pliki", exact: true });
    await tree.getByRole("button", { name: /^Synthetic reference/ }).click();
    await expect(page.getByText("Read-only reference prose.", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "safe", exact: true })).toHaveAttribute(
      "href",
      "https://example.test",
    );
    await expect(page.getByRole("link", { name: "blocked", exact: true })).toHaveCount(0);
    await expect(page.locator("script").filter({ hasText: "synthetic()" })).toHaveCount(0);
    await tree.getByRole("button", { name: /notes\.yaml$/ }).click();
    await expect(
      page.getByText(
        "Ten plik YAML nie jest jeszcze wykonywany: reguły z niego nie tworzą sygnałów. Aplikacja wykonuje tylko strategię główną.",
        { exact: true },
      ),
    ).toBeVisible();
    await tree.getByRole("button", { name: /empty\.txt$/ }).click();
    await expect(page.getByText("Plik jest pusty.", { exact: true })).toBeVisible();
    await tree.getByRole("button", { name: /long\.txt$/ }).click();
    // The numbered source (old `.strat-src`): every line in one pre.
    const source = page.getByTestId("native-strategies").locator("pre");
    await expect(source).toContainText("synthetic line 1");
    await expect(source).toContainText("synthetic line 140");
    await setPrivacy(page, true);
    await expect(page.getByText("Synthetic reference", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Synthetic private description", { exact: true })).toHaveCount(0);
    await setPrivacy(page, false);
    await expect(page.getByTestId("native-strategies")).toBeVisible();
    await expect(tree.getByRole("button", { name: /^Synthetic reference/ })).toBeVisible();
    await tree.getByRole("button", { name: /^Synthetic reference/ }).click();
    await expect(page.getByText("Read-only reference prose.", { exact: true })).toBeVisible();
    await tree.getByRole("button", { name: /strategy\.yaml$/ }).click();
    // The main strategy's status card on the side (old StrategySettings): "Przeładuj", then the toast.
    await page.getByRole("button", { name: "Przeładuj", exact: true }).click();
    await expect(page.getByRole("region", { name: "Powiadomienia", exact: true })).toContainText(
      /Strategia wczytana · v\d+|Brak pliku strategii/,
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
