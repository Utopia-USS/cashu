import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { demoExpectations, rendered } from "../demo-expectations.ts";
import {
  dashboardWindow,
  expect,
  launchDesktop,
  pickProfile,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";

test("investments Home shows generated-source valuations, its filters, the Import drawer and the asset page transaction flow", async () => {
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
    await pickProfile(page, "Demo Anna");
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    // The investments Home (ab24ab6 v2/Home.tsx): head, hero, the split of widgets and rail.
    const portfolio = page.getByTestId("native-portfolio");
    await expect(portfolio).toBeVisible();
    await expect(portfolio.getByRole("heading", { name: "Inwestycje", exact: true })).toBeVisible();
    const hero = portfolio.getByRole("region", { name: "Wartość portfela", exact: true });
    await expect(hero).toBeVisible();
    // The Python app's money format groups thousands always (ui-logic GROUP: "6 372,48 zł").
    const total = new Intl.NumberFormat("pl-PL", {
      style: "currency",
      currency: expected.currency,
      useGrouping: "always",
    } as Intl.NumberFormatOptions).format(Number(expected.total));
    await expect(hero).toContainText(total);
    await expect(
      portfolio.getByRole("heading", { name: "Wartość vs benchmark", exact: true }),
    ).toBeVisible();
    await expect(portfolio.getByRole("region", { name: "Sygnały", exact: true })).toBeVisible();
    await expect(portfolio.getByRole("region", { name: "Alerty", exact: true })).toBeVisible();
    const label = expected.firstLabel;
    // The Aktywa table names the instrument and shows its symbol under it (old `.il`).
    const assetRow = portfolio
      .getByRole("region", { name: "Aktywa", exact: true })
      .getByRole("row")
      .filter({ hasText: label });
    const asset = assetRow.getByRole("button").first();
    await expect(asset).toBeVisible();
    await page.screenshot({ path: join(dataDir, "native-portfolio.png"), fullPage: true });

    // The account filter (head Seg, more than one account): the route keeps it, "Wszystkie" clears it.
    const accounts = portfolio.getByRole("group", { name: "Rachunek", exact: true });
    if ((await accounts.count()) > 0) {
      await accounts.getByRole("button").nth(1).click();
      await expect(page).toHaveURL(/account=/u);
      await expect(hero).toBeVisible();
      await accounts.getByRole("button", { name: "Wszystkie", exact: true }).click();
      await expect(page).not.toHaveURL(/account=/u);
      await expect(asset).toBeVisible();
    }

    // The value chart range (widget Seg) goes into the route.
    await portfolio
      .getByRole("group", { name: "Zakres", exact: true })
      .getByRole("button", { name: "3M", exact: true })
      .click();
    await expect(page).toHaveURL(/period=3m/u);

    // The Import drawer opens from the head and closes again.
    await portfolio.getByRole("button", { name: "Import", exact: true }).click();
    const importer = page.getByRole("dialog", { name: "Import transakcji", exact: true });
    await expect(importer).toBeVisible();
    await page.screenshot({ path: join(dataDir, "native-import.png"), fullPage: true });
    await importer.getByRole("button", { name: "Zamknij", exact: true }).click();
    await expect(importer).toHaveCount(0);

    // An asset row opens the instrument page; its transaction flow writes an owner transaction.
    await asset.click();
    const assetPage = page.getByTestId("native-asset-page");
    await expect(assetPage.getByRole("heading", { name: label, exact: true })).toBeVisible();
    await page.screenshot({ path: join(dataDir, "native-asset-page.png"), fullPage: true });
    const table = assetPage.getByRole("table", { name: "Transakcje", exact: true });
    await expect(table).toBeVisible();
    const rowsBefore = Number(await table.getAttribute("aria-rowcount"));
    await assetPage.getByRole("button", { name: "Dodaj transakcję", exact: true }).click();
    const transaction = page.getByRole("dialog", { name: "Dodaj transakcję", exact: true });
    const type = transaction.getByRole("combobox", { name: "Typ transakcji", exact: true });
    await type.selectOption("fx_conversion");
    await expect(transaction.getByText(/Drugą nogę wymiany/u)).toBeVisible();
    await expect(transaction.getByRole("textbox", { name: "Ilość", exact: true })).toHaveCount(0);
    await type.selectOption("buy");
    await transaction.getByRole("textbox", { name: "Ilość", exact: true }).fill("1,25");
    await transaction.getByRole("button", { name: "Anuluj", exact: true }).click();
    await assetPage.getByRole("button", { name: "Dodaj transakcję", exact: true }).click();
    await expect(transaction.getByRole("textbox", { name: "Ilość", exact: true })).toHaveValue("");
    // An owner buy of this instrument.
    await type.selectOption("buy");
    await transaction.getByRole("textbox", { name: "Ilość", exact: true }).fill("1,25");
    await transaction.getByRole("textbox", { name: "Cena", exact: true }).fill("10");
    await transaction.getByRole("textbox", { name: "Waluta", exact: true }).fill("PLN");
    await transaction.getByRole("textbox", { name: "Waluta gotówki", exact: true }).fill("PLN");
    await transaction
      .getByRole("textbox", { name: "Zmiana gotówki ze znakiem", exact: true })
      .fill("-12,5");
    await transaction
      .getByRole("textbox", { name: "Notatka", exact: true })
      .fill("Synthetic native owner write");
    await transaction.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(transaction).not.toBeVisible();
    // The instrument's transactions table (no note column) gains the owner's buy.
    await expect(table).toHaveAttribute("aria-rowcount", String(rowsBefore + 1));
    await expect(
      table.getByRole("row").filter({ hasText: rendered("-12.5", "PLN") }),
    ).not.toHaveCount(0);
    await page.goBack();
    await expect(hero).toBeVisible();

    // Privacy hides the amounts of the Home and brings them back (the buy moved the value).
    const value = /\d[\d\u00a0 ]*,\d{2}\u00a0zł/u.exec((await hero.textContent()) ?? "")?.[0];
    expect(value).toBeDefined();
    await setPrivacy(page, true);
    await expect(hero).not.toContainText(value ?? "");
    await setPrivacy(page, false);
    await expect(hero).toContainText(value ?? "");
    await pickProfile(page, "Demo Piotr");
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
