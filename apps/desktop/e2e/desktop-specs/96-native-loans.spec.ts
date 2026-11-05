import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { demoExpectations, renderedGrouped } from "../demo-expectations.ts";
import {
  dashboardWindow,
  expect,
  launchDesktop,
  pickProfile,
  rewriteHash,
  setPrivacy,
  settleModalHistory,
  stopHost,
  test,
  until,
} from "../electron-test.ts";
import { restoreNativeBaseline } from "../native-baseline.ts";

test("native loans and asset first steps use actual host stores and reset drafts on vault switches", async () => {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("native generated demo is absent");
  await restoreNativeBaseline(dataDir);
  const expected = demoExpectations().anna.loans;
  if (expected.length === 0) throw new Error("synthetic loans expectations have no loans");
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
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Kredyty", exact: true })
      .click();
    await expect(page.getByTestId("native-loans")).toBeVisible();
    const list = page.getByRole("table", { name: "Kredyty", exact: true });
    await expect(list).toBeVisible();
    for (const loan of expected) {
      await expect(list).toContainText(loan.name);
      await expect(list).toContainText(renderedGrouped(loan.monthlyPayment, loan.currency));
    }

    // The old tab renders the whole schedule in a scrolling card (no virtual rows).
    const longSchedule = page.getByRole("table", { name: "Harmonogram", exact: true });
    expect(await longSchedule.getByRole("row").count()).toBeGreaterThan(50);

    // New loans and installment matching live on the first steps (old Start), as in the Python app.
    await rewriteHash(page, /\/loans\.list(?:\?.*)?$/u, "/setup/loans");
    await page.getByRole("button", { name: "Dodaj kolejny", exact: true }).click();
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

    const installmentStep = page.getByRole("button", { name: /^(Zmień|Wskaż ratę)$/u });
    await installmentStep.click();
    const matching = page.getByRole("dialog", { name: "Rozpoznawanie rat", exact: true });
    await expect(matching).toBeVisible();
    await matching
      .getByRole("combobox", { name: "Kredyt", exact: true })
      .selectOption({ label: "Synthetic UI loan" });
    await matching.getByRole("textbox", { name: "Fraza", exact: true }).fill("SYNTHETIC REPAYMENT");
    await matching.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(matching).toBeHidden();
    await installmentStep.click();
    await matching
      .getByRole("combobox", { name: "Kredyt", exact: true })
      .selectOption({ label: "Synthetic UI loan" });
    await expect(matching.getByRole("textbox", { name: "Fraza", exact: true })).toHaveValue(
      "SYNTHETIC REPAYMENT",
    );
    await matching.getByRole("button", { name: "wyczyść", exact: true }).click();
    await expect(matching).toBeHidden();

    await settleModalHistory(page);
    await rewriteHash(page, /\/setup\/loans(?:\?.*)?$/u, "/loans.list");
    await expect(list).toContainText(renderedGrouped("1000", "PLN"));
    await list.getByRole("button", { name: "Synthetic UI loan", exact: true }).click();
    await page.screenshot({ path: test.info().outputPath("native-loans.png"), fullPage: true });
    await expect(page.getByRole("table", { name: "Harmonogram" }).getByRole("row")).toHaveCount(13);

    await rewriteHash(page, /\/loans\.list(?:\?.*)?$/u, "/setup/loans");
    await setPrivacy(page, true);
    await expect(page.getByText("Synthetic UI loan", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Dodaj kolejny", exact: true })).toBeDisabled();
    await setPrivacy(page, false);

    await page.getByRole("button", { name: "Dodaj kolejny", exact: true }).click();
    await expect(drawer).toBeVisible();
    await pickProfile(page, "Demo");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    for (const route of ["loans.list", "budget/expenses"]) {
      await rewriteHash(
        page,
        /\/overview(?:\?.*)?$|\/loans\.list(?:\?.*)?$|\/setup\/loans(?:\?.*)?$/u,
        `/${route}`,
      );
      await expect(page.getByText("Rozpocznij konfigurację", { exact: true })).toBeVisible();
      await expect(page.getByTestId("native-loans")).toHaveCount(0);
    }
    await pickProfile(page, "Demo Anna");
    await rewriteHash(page, /\/overview(?:\?.*)?$/u, "/setup/assets");
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
