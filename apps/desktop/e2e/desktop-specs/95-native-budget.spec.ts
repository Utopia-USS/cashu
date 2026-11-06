import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  dashboardWindow,
  expect,
  launchDesktop,
  pickLanguage,
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
    const expenses = page.getByRole("main", { name: "Wydatki", exact: true });
    // The currency switch (two currencies with data) is the route's choice; every view shows one currency.
    await expenses.getByRole("button", { name: "EUR", exact: true }).click();
    await expect(page).toHaveURL(/currency=EUR/);
    await expenses.getByRole("button", { name: "PLN", exact: true }).click();
    await expect(page).toHaveURL(/currency=PLN/);
    await expenses.getByRole("button", { name: "Wszystko", exact: true }).click();
    // A legend row (label, amount, share) opens the category's transactions.
    await expenses.getByRole("button", { name: /%/u }).first().click();
    const category = expenses.getByRole("combobox", { name: "Kategoria", exact: true }).first();
    await expect(category).toBeVisible();
    await category.selectOption(
      (await category.inputValue()) === "groceries" ? "dining" : "groceries",
    );
    const toasts = page.getByRole("region", { name: "Powiadomienia", exact: true });
    const toast = toasts.getByRole("status").filter({ hasText: "Zmieniono:" });
    await expect(toast).toBeVisible();
    const allFrom = toast.getByRole("button", { name: /^Wszystkie od /u });
    if ((await allFrom.count()) > 0) {
      await allFrom.click();
      await expect(toasts).toContainText(/\d+ transakcji/u);
    }
    await expenses.getByRole("button", { name: "Zamknij", exact: true }).click();
    await expect(expenses.getByRole("combobox", { name: "Kategoria", exact: true })).toHaveCount(0);
    await tabs.getByRole("button", { name: "Przepływy", exact: true }).click();
    const flows = page.getByRole("main", { name: "Przepływy", exact: true });
    await expect(flows).toBeVisible();
    await expect(
      flows.getByRole("region", { name: "Zamknięcie miesiąca", exact: true }),
    ).toBeVisible();
    await expect(flows).toContainText(/Przepływy \([A-Z]{3}\)/u);
    // The month close card's cushion: the inline form saves, reopens with the saved target, and privacy locks it.
    const close = flows.getByRole("region", { name: "Zamknięcie miesiąca", exact: true });
    await close.getByRole("button", { name: "Ustaw", exact: true }).click();
    const cushionSwitch = close.getByRole("switch", {
      name: "Poduszka przed inwestycjami",
      exact: true,
    });
    if ((await cushionSwitch.getAttribute("aria-checked")) !== "true") await cushionSwitch.click();
    await close
      .getByRole("group", { name: "Cel poduszki", exact: true })
      .getByRole("button", { name: "Kwota", exact: true })
      .click();
    await close.getByRole("textbox", { name: /^Kwota \([A-Z]{3}\)$/u }).fill("1000");
    await close.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(close.getByRole("button", { name: "Zapisz", exact: true })).toHaveCount(0);
    await close.getByRole("button", { name: "Ustaw", exact: true }).click();
    await expect(close.getByRole("textbox", { name: /^Kwota \([A-Z]{3}\)$/u })).toHaveValue(
      /^1000(\.0+)?$/u,
    );
    await close.getByRole("button", { name: "Anuluj", exact: true }).click();
    await setPrivacy(page, true);
    await expect(close.getByRole("button", { name: "Ustaw", exact: true })).toBeDisabled();
    await setPrivacy(page, false);
    await expect(close.getByRole("button", { name: "Ustaw", exact: true })).toBeEnabled();
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
    // An old deep link to the budget module opens Wydatki (the profile switch lands on Przegląd).
    await tabs.getByRole("button", { name: "Wydatki", exact: true }).click();
    await rewriteHash(page, /\/budget\/[^?]*(?=\?|$)/u, "/budget");
    await expect(page.getByRole("main", { name: "Wydatki", exact: true })).toBeVisible();
    // The budget first steps: the expense categories step opens the uncategorized merchants drawer.
    await rewriteHash(page, /\/budget\/[^?]*(?=\?|$)/u, "/setup/budget");
    const reviewCategories = page.getByRole("button", { name: "Przejrzyj", exact: true });
    await expect(page.getByText("Kategorie wydatków", { exact: true }).first()).toBeVisible();
    if ((await reviewCategories.count()) > 0) {
      await reviewCategories.first().click();
      const merchants = page.getByRole("dialog");
      await expect(merchants).toBeVisible();
      const choices = merchants.getByRole("combobox");
      if ((await choices.count()) > 0) await choices.first().selectOption("groceries");
      await merchants.getByRole("button", { name: "Zamknij", exact: true }).click();
      await expect(merchants).toHaveCount(0);
    }
    await rewriteHash(page, /\/setup\/budget[^?]*(?=\?|$)/u, "/budget");
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
    await pickLanguage(page, "English");
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
