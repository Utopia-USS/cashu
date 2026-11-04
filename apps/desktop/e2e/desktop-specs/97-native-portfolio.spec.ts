import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { demoExpectations, rendered } from "../demo-expectations.ts";
import {
  dashboardWindow,
  expect,
  launchDesktop,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";

test("native Portfolio uses generated-source valuations, owner drawers and privacy lifetimes", async () => {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("native generated demo is absent");
  await restoreNativeBaseline(dataDir);
  const expected = demoExpectations().anna.portfolio;
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
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    const portfolio = page.getByTestId("native-portfolio");
    await expect(portfolio).toBeVisible();
    const valueCard = portfolio
      .getByRole("heading", { name: "Wartość", exact: true })
      .locator("xpath=..");
    await expect(valueCard).toBeVisible();
    const total = rendered(expected.total, expected.currency);
    await expect(valueCard).toContainText(total);
    const label = expected.firstLabel;
    await expect(portfolio.getByRole("button", { name: label, exact: true })).toBeVisible();
    await page.screenshot({ path: join(dataDir, "native-portfolio.png"), fullPage: true });

    const accounts = portfolio.getByRole("combobox", { name: "Rachunek", exact: true });
    await accounts.selectOption({ index: 1 });
    await expect(page).toHaveURL(/account=/u);
    await expect(
      portfolio.getByRole("heading", { name: "Wartość", exact: true }).first(),
    ).toBeVisible();
    await accounts.selectOption("");
    await expect(portfolio.getByRole("button", { name: label, exact: true })).toBeVisible();

    await portfolio.getByRole("button", { name: label, exact: true }).click();
    const details = page.getByRole("dialog", { name: "Szczegóły", exact: true });
    await expect(details.getByRole("heading", { name: label, exact: true })).toBeVisible();
    await expect(details.getByRole("table", { name: "Transakcje", exact: true })).toBeVisible();
    await page.screenshot({ path: join(dataDir, "native-asset.png"), fullPage: true });
    await details.getByRole("button", { name: "Otwórz stronę instrumentu", exact: true }).click();
    await expect(
      page.getByTestId("native-asset-page").getByRole("heading", { name: label, exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: join(dataDir, "native-asset-page.png"), fullPage: true });
    await page.goBack();
    await portfolio.getByRole("button", { name: label, exact: true }).click();
    await expect(details.getByRole("heading", { name: label, exact: true })).toBeVisible();
    await details.getByRole("button", { name: "Dodaj transakcję", exact: true }).click();
    const transaction = page.getByRole("dialog", { name: "Dodaj transakcję", exact: true });
    const type = transaction.getByRole("combobox", { name: "Typ transakcji", exact: true });
    await type.selectOption("fx_conversion");
    await expect(transaction.getByText(/Drugą nogę wymiany/u)).toBeVisible();
    await expect(transaction.getByRole("textbox", { name: "Ilość", exact: true })).toHaveCount(0);
    await type.selectOption("buy");
    await transaction.getByRole("textbox", { name: "Ilość", exact: true }).fill("1,25");
    await transaction.getByRole("button", { name: "Anuluj", exact: true }).click();
    await details.getByRole("button", { name: "Dodaj transakcję", exact: true }).click();
    await expect(transaction.getByRole("textbox", { name: "Ilość", exact: true })).toHaveValue("");
    await type.selectOption("deposit");
    await transaction.getByRole("textbox", { name: "Waluta", exact: true }).fill("PLN");
    await transaction.getByRole("textbox", { name: "Waluta gotówki", exact: true }).fill("PLN");
    await transaction
      .getByRole("textbox", { name: "Zmiana gotówki ze znakiem", exact: true })
      .fill("1,25");
    await transaction
      .getByRole("textbox", { name: "Notatka", exact: true })
      .fill("Synthetic native owner write");
    await transaction.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(transaction).not.toBeVisible();
    await details.getByRole("button", { name: "Zamknij", exact: true }).click();

    await portfolio.getByRole("button", { name: "Transakcje", exact: true }).click();
    const history = page.getByRole("dialog", { name: "Transakcje", exact: true });
    const table = history.getByRole("table", { name: "Transakcje", exact: true });
    await expect(table).toBeVisible();
    const saved = table.getByRole("row").filter({ hasText: "Synthetic native owner write" });
    await expect(saved).toBeVisible();
    await expect(saved).toContainText(rendered("1.25", "PLN"));
    const count = Number(await table.getAttribute("aria-rowcount"));
    expect(count).toBeGreaterThan(1);
    if (count > 51) {
      await table.locator("xpath=..").evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await expect(table.getByRole("row").last()).toHaveAttribute("aria-rowindex", String(count));
      expect(await table.getByRole("row").count()).toBeLessThan(count);
    }
    await history.getByRole("button", { name: "Anuluj", exact: true }).click();
    await portfolio.getByRole("button", { name: "Importuj", exact: true }).click();
    const importer = page.getByRole("dialog", { name: "Importuj", exact: true });
    await expect(importer.getByRole("button", { name: "Wybierz", exact: true })).toBeDisabled();
    await importer.getByRole("button", { name: "Anuluj", exact: true }).click();

    await setPrivacy(page, true);
    await expect(portfolio.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await expect(portfolio.getByText(total, { exact: true })).toHaveCount(0);
    await setPrivacy(page, false);
    await expect(portfolio.getByRole("button", { name: label, exact: true })).toBeVisible();
    await portfolio.getByRole("combobox", { name: "Okres", exact: true }).selectOption("3m");
    await expect(page).toHaveURL(/period=3m/u);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Piotr" });
    await expect(page.getByRole("main", { name: "Przegląd", exact: true })).toBeVisible();
    expect(await page.getByRole("dialog").count()).toBe(0);
  } finally {
    if (app) {
      await app.close().catch(() => {});
      await stopHost(dataDir).catch(() => {});
    }
    if (host.exitCode === null) {
      host.kill("SIGTERM");
      await new Promise<void>((resolve) => host.once("exit", () => resolve()));
    }
  }
});
