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

test("native budget tabs use the real generated demo vault, update categories and cushion, and retain honest import boundaries", async () => {
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
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Budżet", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Wydatki", level: 1 })).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Moduły" })
        .getByRole("button", { name: "Budżet", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    const currency = page.getByRole("combobox", { name: "Waluta", exact: true });
    await expect(currency).toBeVisible();
    await currency.selectOption("EUR");
    await expect(page).toHaveURL(/currency=EUR/);
    await currency.selectOption("PLN");
    await page.getByRole("combobox", { name: "Zakres", exact: true }).selectOption("all");
    const slices = page.getByRole("group").filter({ has: page.locator("svg") });
    await expect(slices.first()).toBeVisible();
    const arc = slices.first().getByRole("button").first();
    await arc.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("region", { name: "Transakcje", exact: true }).first(),
    ).toBeVisible();
    const category = page.getByRole("combobox", { name: "Kategoria", exact: true }).first();
    await category.selectOption("groceries");
    await expect(page.getByRole("status").filter({ hasText: "Zapisano." })).toBeVisible();
    await page.getByRole("button", { name: "Odbiorcy bez kategorii", exact: true }).click();
    const merchants = page.getByRole("dialog", { name: "Odbiorcy bez kategorii", exact: true });
    await expect(merchants).toBeVisible();
    const merchantChoices = merchants.getByRole("combobox", { name: "Kategoria", exact: true });
    const merchantCount = await merchantChoices.count();
    if (merchantCount > 0) {
      await merchantChoices.first().selectOption("groceries");
      await expect(merchantChoices).toHaveCount(merchantCount);
    }
    await merchants.getByRole("button", { name: "Zamknij", exact: true }).click();
    await page.getByRole("button", { name: "Przepływy", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Przepływy", level: 1 })).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Zamknięcie miesiąca", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Ustaw poduszkę", exact: true }).click();
    const cushion = page.getByRole("dialog", { name: "Poduszka finansowa", exact: true });
    await expect(cushion).toBeVisible();
    await cushion.getByRole("combobox", { name: "Cel", exact: true }).selectOption("amount");
    await cushion.getByRole("checkbox", { name: "Poduszka finansowa", exact: true }).check();
    await cushion.getByRole("textbox", { name: "Cel", exact: true }).fill("1000");
    await cushion.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(cushion).toHaveCount(0);
    await page.getByRole("button", { name: "Ustaw poduszkę", exact: true }).click();
    await expect(cushion.getByRole("textbox", { name: "Cel", exact: true })).toHaveValue("1000.00");
    await cushion.getByRole("textbox", { name: "Cel", exact: true }).fill("777");
    // A real device setting push can arrive while the modal owns focus.
    await page.evaluate(() => {
      const toggle = document.querySelector<HTMLInputElement>(
        'header input[type="checkbox"][aria-label="Ukryj kwoty"]',
      );
      if (!toggle) throw new Error("privacy control absent");
      toggle.click();
    });
    await expect(cushion).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ustaw poduszkę", exact: true })).toBeDisabled();
    await setPrivacy(page, false);
    await page.getByRole("button", { name: "Ustaw poduszkę", exact: true }).click();
    await expect(cushion.getByRole("textbox", { name: "Cel", exact: true })).toHaveValue("1000.00");
    await cushion.getByRole("button", { name: "Zamknij", exact: true }).click();
    await page.getByRole("button", { name: "Subskrypcje", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Subskrypcje", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Synchronizuj bank", exact: true }).click();
    await expect(page.getByRole("main")).toContainText(
      "Synchronizacja banków i konektorów nie jest jeszcze dostępna w aplikacji.",
    );
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Import", exact: true })).toContainText(
      "Import plików nie jest jeszcze dostępny w aplikacji.",
    );
    await pickProfile(page, "Demo");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await pickProfile(page, "Demo Anna");
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Budżet", exact: true })
      .click();
    await setPrivacy(page, true);
    await expect(page.getByRole("main")).toContainText("•••");
    await setPrivacy(page, false);
    await page.screenshot({
      path: test.info().outputPath("native-budget.png"),
      fullPage: true,
    });
    // The language lives in Settings, as in the Python app.
    await rewriteHash(page, /\/budget\/[^?]*(?=\?|$)/u, "/settings");
    await page.getByRole("combobox", { name: "Język", exact: true }).selectOption("en");
    await expect(page.getByRole("combobox", { name: "Language", exact: true })).toHaveValue("en");
    await page
      .getByRole("navigation", { name: "Modules" })
      .getByRole("button", { name: "Budget", exact: true })
      .click();
    await expect(page.getByRole("heading", { name: "Spending", level: 1 })).toBeVisible();
  } finally {
    await app?.close();
    await stopHost(dataDir);
    if (host.exitCode === null) {
      host.kill("SIGTERM");
      await until(() => host.exitCode !== null);
    }
  }
});
