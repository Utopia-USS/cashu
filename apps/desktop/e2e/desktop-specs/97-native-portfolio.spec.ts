import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { demoExpectations } from "../demo-expectations.ts";
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

test("investments Home shows generated-source valuations, its filters, no manual Import and the asset page transaction flow", async () => {
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

    // Investment imports come from the agent (propose_import, approved by the owner): no manual Import.
    await expect(portfolio.getByRole("button", { name: "Import", exact: true })).toHaveCount(0);

    // An asset row opens the asset drawer over the Home (ab24ab6 `assets/{id}`); its transactions drawer and
    // the manual transaction drawer (old Drawers.tsx TxnsDrawer / TxnDrawer) write an owner transaction.
    await asset.click();
    // The drawer is named by the instrument's name (DetailDrawer); its head carries the symbol.
    const assetDrawer = page.getByRole("dialog").filter({ hasText: label }).first();
    await expect(assetDrawer).toBeVisible();
    await expect(page).toHaveURL(/\/assets\//u);
    await page.screenshot({ path: join(dataDir, "native-asset-drawer.png"), fullPage: true });
    await assetDrawer.getByRole("button", { name: /^\d+ transakcj/u }).click();
    const txns = page.getByRole("dialog", { name: "Transakcje instrumentu", exact: true });
    await expect(txns).toBeVisible();
    await expect(txns.getByRole("row").first()).toBeVisible();
    const rowsBefore = await txns.getByRole("row").count();
    await txns.getByRole("button", { name: "Dodaj transakcję", exact: true }).click();
    const transaction = page.getByRole("dialog", { name: "Dodaj transakcję", exact: true });
    await expect(transaction).toBeVisible();
    const type = transaction.getByRole("combobox", { name: "Typ", exact: true });
    await type.selectOption("deposit");
    await expect(transaction.getByRole("textbox", { name: "Ilość", exact: true })).toHaveCount(0);
    await type.selectOption("buy");
    await transaction.getByRole("textbox", { name: "Ilość", exact: true }).fill("1,25");
    await transaction.getByRole("textbox", { name: /^Cena \(/u }).fill("10");
    // A foreign-currency instrument in a PLN account asks for the rate (old TxnDrawer `fxRequired`).
    const rate = transaction.getByRole("textbox", { name: /^Kurs \(/u });
    if (await rate.count()) await rate.fill("4,25");
    await transaction
      .getByRole("textbox", { name: "Notatka", exact: true })
      .fill("Synthetic native owner write");
    await transaction.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(transaction).toHaveCount(0);
    await expect(page.getByText("Zapisano transakcję", { exact: false })).toBeVisible();
    // The asset's transactions list gains the owner's buy.
    await assetDrawer.getByRole("button", { name: /^\d+ transakcj/u }).click();
    await expect(txns.getByRole("row")).toHaveCount(rowsBefore + 1);
    await txns.getByRole("button", { name: "Zamknij", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(assetDrawer).toHaveCount(0);
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
