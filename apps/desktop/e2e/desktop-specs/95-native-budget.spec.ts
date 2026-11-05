import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  dashboardWindow,
  expect,
  launchDesktop,
  pickProfile,
  profilePill,
  rewriteHash,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";

test("native budget tabs follow the Python app: Wydatki, Przepływy and Subskrypcje with the tab bar's Import and sync", async () => {
  const repo = process.env.E2E_REPO,
    dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("isolated native demo absent");
  await restoreNativeBaseline(dataDir);
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
  let error = "";
  host.stderr?.on("data", (chunk) => {
    error += String(chunk);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    await until(() => existsSync(join(dataDir, "overview-ready")) || host.exitCode !== null);
    expect(host.exitCode, error).toBeNull();
    app = await launchDesktop({ dataDir });
    const { page } = await dashboardWindow(app);
    await setPrivacy(page, false);
    await pickProfile(page, "Demo Anna");
    await expect(profilePill(page)).toHaveAccessibleName("Demo Anna");
    const tabs = page.getByRole("navigation", { name: "Moduły" });
    // Majątek has no tab of its own (it lives on Przegląd), the budget has three.
    await expect(tabs.getByRole("button", { name: "Majątek", exact: true })).toHaveCount(0);
    await tabs.getByRole("button", { name: "Wydatki", exact: true }).click();
    await expect(page.getByRole("main", { name: "Wydatki", exact: true })).toBeVisible();
    await expect(tabs.getByRole("button", { name: "Wydatki", exact: true })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await tabs.getByRole("button", { name: "Przepływy", exact: true }).click();
    const flows = page.getByRole("main", { name: "Przepływy", exact: true });
    await expect(flows).toBeVisible();
    await expect(
      flows.getByRole("region", { name: "Zamknięcie miesiąca", exact: true }),
    ).toBeVisible();
    await expect(flows).toContainText(/Przepływy \([A-Z]{3}\)/u);
    await flows.getByRole("combobox", { name: "Agregacja", exact: true }).selectOption("quarterly");
    await expect(page).toHaveURL(/gran=quarterly/);
    await flows.getByRole("button", { name: "Max", exact: true }).click();
    await expect(page).toHaveURL(/range=0/);
    await tabs.getByRole("button", { name: "Subskrypcje", exact: true }).click();
    const subs = page.getByRole("main", { name: "Subskrypcje", exact: true });
    await expect(subs.getByRole("region", { name: "Subskrypcje", exact: true })).toBeVisible();
    await expect(subs.getByRole("columnheader", { name: "Odbiorca", exact: true })).toBeVisible();
    // The tab bar actions of a budget tab: Import opens the statement drawer at its file step.
    await tabs.getByRole("button", { name: "Import", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Import wyciągu", exact: true });
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: "Podgląd", exact: true })).toBeDisabled();
    await drawer.getByRole("button", { name: "← Wstecz", exact: true }).click();
    await expect(drawer.getByRole("radio", { name: /Plik CSV z banku/u })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(tabs.getByRole("button", { name: "↻ Synchronizuj", exact: true })).toBeVisible();
    await pickProfile(page, "Demo");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await pickProfile(page, "Demo Anna");
    // An old deep link to the budget module opens Wydatki.
    await rewriteHash(page, /\/budget\/[^?]*(?=\?|$)/u, "/budget");
    await expect(page.getByRole("main", { name: "Wydatki", exact: true })).toBeVisible();
    await setPrivacy(page, true);
    await expect(page.getByRole("main")).toContainText("•••");
    await setPrivacy(page, false);
    await page.screenshot({
      path: test.info().outputPath("native-budget.png"),
      fullPage: true,
    });
    // The language lives in Settings, as in the Python app.
    await rewriteHash(page, /\/budget\/[^?]*(?=\?|$)/u, "/settings");
    await page
      .getByRole("group", { name: "Język", exact: true })
      .getByRole("button", { name: "English", exact: true })
      .click();
    await expect(
      page
        .getByRole("group", { name: "Language", exact: true })
        .getByRole("button", { name: "English", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page
      .getByRole("navigation", { name: "Modules" })
      .getByRole("button", { name: "Expenses", exact: true })
      .click();
    await expect(page.getByRole("main", { name: "Expenses", exact: true })).toBeVisible();
  } finally {
    await app?.close();
    await stopHost(dataDir);
    if (host.exitCode === null) {
      host.kill("SIGTERM");
      await until(() => host.exitCode !== null);
    }
  }
});
