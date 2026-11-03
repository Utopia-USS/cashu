import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { dashboardWindow, expect, launchDesktop, stopHost, test, until } from "../electron-test.ts";

test("native budget tabs use the real generated demo vault, update categories and cushion, and retain honest import boundaries", async () => {
  const repo = process.env.E2E_REPO,
    dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("isolated native demo absent");
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
    app = await launchDesktop({ dataDir, env: { CASHU_DESKTOP_NATIVE_OVERVIEW: "1" } });
    const { page } = await dashboardWindow(app);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
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
      const label = [...document.querySelectorAll("label")].find((node) => node.textContent?.includes("Ukryj kwoty"));
      const toggle = label?.querySelector<HTMLInputElement>('input[type="checkbox"]');
      if (!toggle) throw new Error("privacy control absent");
      toggle.click();
    });
    await expect(cushion).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Ustaw poduszkę", exact: true })).toBeDisabled();
    await page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true }).uncheck();
    await page.getByRole("button", { name: "Ustaw poduszkę", exact: true }).click();
    await expect(cushion.getByRole("textbox", { name: "Cel", exact: true })).toHaveValue("1000.00");
    await cushion.getByRole("button", { name: "Zamknij", exact: true }).click();
    await page.getByRole("button", { name: "Subskrypcje", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Subskrypcje", level: 1 })).toBeVisible();
    await page.getByRole("button", { name: "Synchronizuj bank", exact: true }).click();
    await expect(page.getByRole("main")).toContainText(
      "Synchronizacja banku i konektorów jest dostępna w poprzednim widoku.",
    );
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Import", exact: true })).toContainText(
      "jeszcze niedostępny",
    );
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo" });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Budżet", exact: true })
      .click();
    await page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true }).check();
    await expect(page.getByRole("main")).toContainText("•••");
    await page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true }).uncheck();
    await page.screenshot({
      path: "/Users/owner/cashu-lab/checkpoints/S55c-gpt.png",
      fullPage: true,
    });
    await page.getByRole("combobox", { name: "Język", exact: true }).selectOption("en");
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
