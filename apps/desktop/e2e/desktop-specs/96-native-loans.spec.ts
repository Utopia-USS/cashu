import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { D } from "@cashu/domain";
import { formatDecimalValue } from "@cashu/i18n/values";
import {
  bridgeToken,
  dashboardWindow,
  expect,
  launchDesktop,
  stopHost,
  test,
  until,
} from "../electron-test.ts";

test("native loans and asset first steps use actual host stores and reset drafts on vault switches", async () => {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("native generated demo is absent");
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
    const { page, origin } = await dashboardWindow(app);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Kredyty", exact: true })
      .click();
    await expect(page.getByTestId("native-loans")).toBeVisible();
    const token = await bridgeToken(page);
    const api = await page.request.get(`${origin}/api/p/demo-anna/loans`, {
      headers: { "X-Cashu-Token": token },
    });
    expect(api.ok()).toBe(true);
    const source = (await api.json()) as {
      name: string;
      monthly_payment: number;
      currency: string;
    }[];
    for (const loan of source) {
      await expect(page.getByRole("combobox", { name: "Wybierz kredyt" })).toContainText(loan.name);
      await expect(page.getByRole("table", { name: "Kredyty", exact: true })).toContainText(
        formatDecimalValue(D(String(loan.monthly_payment)), "pl-PL", { currency: loan.currency })
          .text,
      );
    }

    const longSchedule = page.getByRole("table", { name: "Harmonogram", exact: true });
    const scheduleRows = Number(await longSchedule.getAttribute("aria-rowcount"));
    expect(scheduleRows).toBeGreaterThan(50);
    const scheduleScroll = longSchedule.locator("xpath=..");
    await scheduleScroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(longSchedule.getByRole("row").last()).toHaveAttribute(
      "aria-rowindex",
      String(scheduleRows),
    );
    expect(await longSchedule.getByRole("row").count()).toBeLessThan(50);
    await scheduleScroll.evaluate((node) => {
      node.scrollTop = 0;
    });

    await page.getByRole("button", { name: "Dodaj kredyt", exact: true }).first().click();
    const drawer = page.getByRole("dialog", { name: "Dodaj kredyt", exact: true });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("textbox", { name: "Nazwa", exact: true }).fill("Synthetic UI loan");
    await drawer.getByRole("textbox", { name: "Kwota kredytu", exact: true }).fill("12000");
    await drawer
      .getByRole("textbox", { name: "Oprocentowanie (% rocznie)", exact: true })
      .fill("0");
    await drawer.getByRole("textbox", { name: "Okres", exact: true }).fill("1");
    await drawer.getByRole("button", { name: "Dodaj", exact: true }).click();
    await expect(drawer).toBeHidden();
    await expect(page.getByRole("combobox", { name: "Wybierz kredyt" })).toContainText(
      "Synthetic UI loan",
    );
    await page
      .getByRole("combobox", { name: "Wybierz kredyt" })
      .selectOption({ label: "Synthetic UI loan" });
    await expect(page.getByRole("table", { name: "Harmonogram" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Kredyty", exact: true })).toContainText(
      formatDecimalValue(D("1000"), "pl-PL", { currency: "PLN" }).text,
    );
    await page.screenshot({ path: test.info().outputPath("native-loans.png"), fullPage: true });
    await expect(page.getByRole("table", { name: "Harmonogram" }).getByRole("row")).toHaveCount(13);
    await page.getByRole("button", { name: "Rozpoznawanie rat", exact: true }).click();
    const matching = page.getByRole("dialog", { name: "Rozpoznawanie rat", exact: true });
    await expect(matching).toBeVisible();
    await matching.getByRole("textbox", { name: "Fraza", exact: true }).fill("SYNTHETIC REPAYMENT");
    await matching.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(matching).toBeHidden();
    await page.getByRole("button", { name: "Rozpoznawanie rat", exact: true }).click();
    await matching
      .getByRole("combobox", { name: "Kredyt", exact: true })
      .selectOption({ label: "Synthetic UI loan" });
    await expect(matching.getByRole("textbox", { name: "Fraza", exact: true })).toHaveValue(
      "SYNTHETIC REPAYMENT",
    );
    await matching.getByRole("button", { name: "wyczyść", exact: true }).click();
    await expect(matching).toBeHidden();
    await page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true }).check();
    await expect(page.getByText("Synthetic UI loan", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Dodaj kredyt", exact: true }).first(),
    ).toBeDisabled();
    await page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true }).uncheck();

    await page.getByRole("button", { name: "Dodaj kredyt", exact: true }).first().click();
    await expect(drawer).toBeVisible();
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo" });
    await expect(page.getByRole("dialog")).toHaveCount(0);
    for (const route of ["loans.list", "budget/expenses"]) {
      await page.evaluate((route) => {
        const next = new URL(location.href);
        next.hash = next.hash.replace(/\/overview(?:\?.*)?$|\/loans\.list(?:\?.*)?$/u, `/${route}`);
        location.assign(next.href);
      }, route);
      await expect(page.getByText("Rozpocznij konfigurację", { exact: true })).toBeVisible();
      await expect(page.getByTestId("native-loans")).toHaveCount(0);
    }
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await page.evaluate(() => {
      const next = new URL(location.href);
      next.hash = next.hash.replace(/\/overview(?:\?.*)?$/u, "/setup/assets");
      location.assign(next.href);
    });
    await expect(page.getByTestId("native-assets-start")).toBeVisible();
    await page.getByRole("button", { name: "Dodaj auto", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("dialog").getByRole("button", { name: "Anuluj", exact: true }).click();
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
