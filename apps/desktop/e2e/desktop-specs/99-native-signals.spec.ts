import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  dashboardWindow,
  expect,
  launchDesktop,
  setPrivacy,
  stopHost,
  test,
  until,
} from "../electron-test.ts";

test("native Signals uses generated owner state across Home, dialogs and pages", async () => {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("native generated demo is absent");
  const artifactDir = process.env.E2E_SIGNALS_ARTIFACT_DIR ?? dataDir;
  mkdirSync(artifactDir, { recursive: true });
  const host: ChildProcess = spawn(
    process.execPath,
    [
      "--import",
      join(repo, "tools/node-ts/resolveTs.ts"),
      join(repo, "apps/host/src/testing/seedOverviewDemo.ts"),
      "serve",
    ],
    {
      env: { ...process.env, CASHU_E2E_SIGNALS: "1" },
      stdio: ["ignore", "ignore", "pipe"],
    },
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
    const pageErrors: string[] = [];
    let consoleErrors = 0;
    page.on("pageerror", (error) => pageErrors.push(error.name));
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors++;
    });
    const attachRouteDiagnostics = async (phase: string) => {
      const state = await page.evaluate(() => ({
        connected:
          document
            .querySelector('[data-testid="host-connection"]')
            ?.textContent?.includes("Połączono") ?? false,
        loading: document.body.textContent?.includes("Otwieranie danych lokalnych") ?? false,
        portfolio: document.querySelector('[data-testid="native-portfolio"]') !== null,
      }));
      await test.info().attach("signals-route-diagnostics", {
        body: Buffer.from(
          JSON.stringify({
            phase,
            ...state,
            pageErrors,
            consoleErrors,
            hostExit: host.exitCode,
            hostSignal: host.signalCode,
            hostStderrLines: errors.trim() ? errors.trim().split("\n").length : 0,
          }),
        ),
        contentType: "application/json",
      });
    };
    await setPrivacy(page, false);
    await page
      .getByRole("combobox", { name: "Profil", exact: true })
      .selectOption({ label: "Demo Anna" });
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    const homeRail = page.getByTestId("native-investment-home-rail");
    try {
      await expect(homeRail).toBeVisible();
    } catch (error) {
      await attachRouteDiagnostics("home");
      throw error;
    }
    await homeRail.getByRole("button", { name: "+ Nowy", exact: true }).click();
    const openedFromHome = page.getByTestId("native-signals-alerts");
    try {
      await expect(openedFromHome.getByRole("region", { name: "Nowy alert" })).toBeVisible();
    } catch (error) {
      await attachRouteDiagnostics("new-alert");
      throw error;
    }
    await page.goBack();
    await expect(homeRail).toBeVisible();
    const rail = homeRail;
    await expect(rail).toBeVisible();
    await expect(rail).toContainText("S55F");
    await page.screenshot({ path: join(artifactDir, "native-signals-home.png"), fullPage: true });
    await rail
      .getByRole("region", { name: "Sygnały" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    const dialog = page.getByRole("dialog", { name: "Sygnały", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Synthetic watched chance");
    expect(await dialog.locator("[data-signal]").count()).toBeLessThan(50);
    await page.screenshot({ path: join(artifactDir, "native-signals-dialog.png") });
    await dialog
      .getByRole("region", { name: "Obserwowane" })
      .getByRole("button", { name: "Zanotuj decyzję" })
      .first()
      .click();
    const decisionDialog = page.getByRole("dialog", { name: "Zanotuj decyzję" });
    await decisionDialog.getByRole("combobox", { name: "Decyzja" }).selectOption("held");
    await decisionDialog.getByRole("textbox", { name: "Powód" }).fill("Synthetic decision99");
    await decisionDialog.getByRole("button", { name: "Zapisz" }).click();
    await expect(decisionDialog).toHaveCount(0);
    await dialog.getByRole("button", { name: "Zamknij" }).click();
    await rail
      .getByRole("region", { name: "Alerty" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    const alerts = page.getByTestId("native-signals-alerts");
    await expect(alerts).toBeVisible();
    await expect(alerts).toContainText("Synthetic Signals alert");
    const alertRow = alerts.locator("[data-index]").filter({ hasText: "Synthetic Signals alert" });
    await alertRow.getByRole("button", { name: "Wycisz" }).click();
    await expect(alertRow).toContainText("Wyciszony");
    await alertRow.getByRole("button", { name: "Włącz" }).click();
    await expect(alertRow.getByRole("button", { name: "Wycisz" })).toBeVisible();
    await alerts.getByRole("button", { name: "Nowy alert" }).click();
    await expect(alerts.getByRole("heading", { name: "Nowy alert" })).toBeVisible();
    await page.screenshot({ path: join(artifactDir, "native-signals-alerts.png"), fullPage: true });
    const newAlert = alerts.getByRole("region", { name: "Nowy alert" });
    await newAlert.getByRole("combobox", { name: "Instrument" }).selectOption({ label: "WATCH" });
    await newAlert.getByLabel("Poziom").fill("100");
    await newAlert.getByRole("textbox", { name: "Tytuł" }).fill("Synthetic new alert99");
    await newAlert.getByRole("button", { name: "Zapisz" }).click();
    const createdAlert = alerts
      .locator("[data-index]")
      .filter({ hasText: "Synthetic new alert99" });
    await expect(createdAlert).toBeVisible();
    await createdAlert.getByRole("button", { name: "Edytuj alert" }).click();
    const editedAlert = alerts.getByRole("region", { name: "Edytuj alert" });
    await editedAlert.getByRole("textbox", { name: "Tytuł" }).fill("Synthetic edited alert99");
    await editedAlert.getByRole("button", { name: "Zapisz" }).click();
    const updatedAlert = alerts.locator("[data-index]").filter({
      hasText: "Synthetic edited alert99",
    });
    await expect(updatedAlert).toBeVisible();
    await updatedAlert.getByRole("button", { name: "Usuń" }).click();
    await expect(updatedAlert).toHaveCount(0);
    await alerts.getByRole("button", { name: "Przywróć" }).click();
    await expect(updatedAlert).toBeVisible();
    const csvPath = join(artifactDir, "native-signals-history.csv");
    rmSync(csvPath, { force: true });
    await app.evaluate(({ session }, savePath) => {
      (globalThis as Record<string, unknown>).__signalsCsvDownload = "pending";
      session.defaultSession.once("will-download", (_event, item) => {
        if (item.getFilename() !== "historia-alertow.csv") {
          (globalThis as Record<string, unknown>).__signalsCsvDownload = "wrong_filename";
          return;
        }
        item.setSavePath(savePath);
        item.once("done", (_event, state) => {
          (globalThis as Record<string, unknown>).__signalsCsvDownload = state;
        });
      });
    }, csvPath);
    await alerts.getByRole("button", { name: "Eksportuj CSV" }).click();
    await expect
      .poll(() =>
        app?.evaluate(() => (globalThis as Record<string, unknown>).__signalsCsvDownload as string),
      )
      .toBe("completed");
    const csv = readFileSync(csvPath);
    expect(csv.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(csv.toString("utf8")).toContain("Synthetic Signals alert");
    await alerts.getByRole("button", { name: "Portfel", exact: true }).first().click();
    await rail
      .getByRole("region", { name: "Sygnały" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    await dialog.getByRole("button", { name: "Lista obserwowanych" }).click();
    const watchlist = page.getByTestId("native-signals-watchlist");
    await expect(watchlist).toContainText("WATCH");
    await watchlist.getByRole("combobox", { name: "Szukaj instrumentu" }).fill("NEW.WA");
    await expect(watchlist.getByText("Wyszukiwanie zdalne niedostępne.")).toBeVisible();
    await watchlist.getByRole("button", { name: "Dodaj wpisany symbol" }).click();
    const added = watchlist.getByRole("button", { name: "NEW", exact: true });
    await expect(added).toBeVisible();
    await added.locator("..").getByRole("button", { name: "Usuń" }).click();
    await expect(added).toHaveCount(0);
    await watchlist.getByRole("button", { name: "Cofnij" }).click();
    await expect(added).toBeVisible();
    await page.screenshot({
      path: join(artifactDir, "native-signals-watchlist.png"),
      fullPage: true,
    });
    await watchlist.getByRole("button", { name: "Portfel", exact: true }).first().click();
    await rail
      .getByRole("region", { name: "Sygnały" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    await dialog.getByRole("button", { name: "Dziennik" }).click();
    const journal = page.getByTestId("native-signals-journal");
    await expect(journal).toBeVisible();
    await journal.getByRole("combobox", { name: "Instrument" }).selectOption({ label: "WATCH" });
    await expect(journal).toContainText("Synthetic watched chance");
    const savedDecision = journal.locator("[data-index]").filter({
      hasText: "Synthetic decision99",
    });
    await expect(savedDecision).toBeVisible();
    await savedDecision.getByRole("button", { name: "Cofnij" }).click();
    await expect(journal).not.toContainText("Synthetic decision99");
    const privacy = page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true });
    await privacy.click();
    await test.info().attach("privacy-transition-scalar", {
      body: Buffer.from(
        JSON.stringify(
          await page.evaluate(() => ({
            route: `${location.pathname}${location.search}${location.hash}`,
            journal: document.querySelector('[data-testid="native-signals-journal"]') !== null,
            portfolio:
              document.querySelector('[data-testid="native-investment-home-rail"]') !== null,
            loading: document.body.textContent?.includes("Otwieranie danych lokalnych") ?? false,
            hostConnection: document.querySelector('[data-testid="host-connection"]')?.textContent,
            checked: (document.querySelector('input[type="checkbox"]') as HTMLInputElement | null)
              ?.checked,
          })),
        ),
      ),
      contentType: "application/json",
    });
    await expect(privacy).toBeChecked();
    await expect(page.getByTestId("native-signals-journal")).toContainText(
      "Ukryto w trybie prywatnym.",
    );
    await page.screenshot({
      path: join(artifactDir, "native-signals-privacy.png"),
      fullPage: true,
    });
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
