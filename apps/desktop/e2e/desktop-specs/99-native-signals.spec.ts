import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
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

test("native Signals uses generated owner state across Home, dialogs and pages", async () => {
  const repo = process.env.E2E_REPO;
  const dataDir = process.env.E2E_NATIVE_DATA_DIR;
  if (!repo || !dataDir) throw new Error("native generated demo is absent");
  await restoreNativeBaseline(dataDir);
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
    await pickProfile(page, "Demo Anna");
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    // The ported Home (ab24ab6 look): the rail widgets are regions of the page box.
    const homeRail = page.getByTestId("native-portfolio");
    try {
      await expect(homeRail).toBeVisible();
    } catch (error) {
      await attachRouteDiagnostics("home");
      throw error;
    }
    const rail = homeRail;
    await expect(rail).toBeVisible();
    await expect(rail).toContainText("S55F");
    await page.screenshot({ path: join(artifactDir, "native-signals-home.png"), fullPage: true });
    // The ported signals dialog (ab24ab6 v2/Signals.tsx SignalsDialog): Portfel / Obserwowane columns.
    await rail
      .getByRole("region", { name: "Sygnały" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    const dialog = page.getByRole("dialog", { name: "Sygnały", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Obserwowane");
    // The old dialog lists every signal (no virtual window): each row once.
    const signalIds = await dialog
      .locator("[data-signal]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-signal")));
    expect(signalIds.length).toBeGreaterThan(0);
    expect(new Set(signalIds).size).toBe(signalIds.length);
    await page.screenshot({ path: join(artifactDir, "native-signals-dialog.png") });
    // A watched subject's `Zanotuj decyzję`: the inline form, or the position dialog for a multi-signal instrument.
    await dialog
      .locator("[data-signal], [data-group]")
      .filter({ hasText: "WATCH" })
      .getByRole("button", { name: "Zanotuj decyzję" })
      .first()
      .click();
    await page.getByRole("textbox", { name: "Powód decyzji" }).fill("Synthetic decision99");
    await page.getByRole("button", { name: "Zapisz decyzję" }).click();
    await expect(page.getByRole("textbox", { name: "Powód decyzji" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Zamknij" }).click();
    await expect(dialog).toHaveCount(0);
    await rail
      .getByRole("region", { name: "Alerty" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    const alerts = page.getByTestId("native-signals-alerts");
    await expect(alerts).toBeVisible();
    await expect(alerts).toContainText("Synthetic Signals alert");
    await alerts.getByRole("button", { name: "Wycisz alert Synthetic Signals alert" }).click();
    await expect(
      // the alerts table row (the triggered history below lists the alert too)
      alerts.getByRole("row").filter({ hasText: "Synthetic Signals alert" }).first(),
    ).toContainText("wyciszony");
    await alerts.getByRole("button", { name: "Włącz alert Synthetic Signals alert" }).click();
    await expect(
      alerts.getByRole("button", { name: "Wycisz alert Synthetic Signals alert" }),
    ).toBeVisible();
    await page.screenshot({ path: join(artifactDir, "native-signals-alerts.png"), fullPage: true });
    // No new-alert form (alerts come from the agent and the strategy): the edit form opens only from a row.
    await expect(alerts.getByRole("region", { name: "Edycja alertu" })).toHaveCount(0);
    await alerts.getByRole("button", { name: "Edytuj alert Synthetic Signals alert" }).click();
    const editedAlert = alerts.getByRole("region", { name: "Edycja alertu" });
    await editedAlert.getByRole("textbox", { name: "Tytuł" }).fill("Synthetic edited alert99");
    await editedAlert.getByRole("button", { name: "Zapisz" }).click();
    await expect(editedAlert).toHaveCount(0);
    // the alerts table row (the triggered history below lists the alert under its current title too)
    const updatedAlert = alerts.getByRole("row").filter({ hasText: "Synthetic edited alert99" });
    await expect(updatedAlert.first()).toBeVisible();
    await alerts.getByRole("button", { name: "Usuń alert Synthetic edited alert99" }).click();
    await expect(updatedAlert).toHaveCount(0);
    // Deleted at once; the toast's `Cofnij` restores it (old removeAlertWithUndo).
    await page.getByRole("button", { name: "Cofnij" }).first().click();
    await expect(updatedAlert.first()).toBeVisible();
    const csvPath = join(artifactDir, "native-signals-history.csv");
    rmSync(csvPath, { force: true });
    await app.evaluate(({ session }, savePath) => {
      (globalThis as Record<string, unknown>).__signalsCsvDownload = "pending";
      session.defaultSession.once("will-download", (_event, item) => {
        if (item.getFilename() !== "alerty-historia.csv") {
          (globalThis as Record<string, unknown>).__signalsCsvDownload = "wrong_filename";
          return;
        }
        item.setSavePath(savePath);
        item.once("done", (_event, state) => {
          (globalThis as Record<string, unknown>).__signalsCsvDownload = state;
        });
      });
    }, csvPath);
    await alerts.getByRole("button", { name: "eksport CSV" }).click();
    await expect
      .poll(() =>
        app?.evaluate(() => (globalThis as Record<string, unknown>).__signalsCsvDownload as string),
      )
      .toBe("completed");
    const csv = readFileSync(csvPath);
    expect(csv.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(csv.toString("utf8")).toContain("Synthetic edited alert99");
    // Back to the Home through the crumb; the watchlist is Aktywa's Obserwowane tab with the search row.
    await alerts.getByRole("navigation").getByRole("button", { name: "Inwestycje" }).click();
    await expect(rail).toBeVisible();
    const assets = rail.getByRole("region", { name: "Aktywa" });
    await assets.getByRole("button", { name: /Obserwowane/u }).click();
    await assets.getByRole("button", { name: "+ Dodaj" }).click();
    await assets.getByRole("combobox", { name: "Szukaj instrumentu" }).fill("NEW.WA");
    await expect(assets.getByText("Wyszukiwanie online niedostępne")).toBeVisible();
    await assets.getByRole("option", { name: "Dodaj „NEW.WA”" }).click();
    const added = assets.getByRole("row").filter({ hasText: "NEW" });
    await expect(added).toBeVisible();
    await added.getByRole("button", { name: /Przestań obserwować/u }).click();
    await expect(added).toHaveCount(0);
    await page.getByRole("button", { name: "Cofnij" }).first().click();
    await expect(added).toBeVisible();
    await page.screenshot({
      path: join(artifactDir, "native-signals-watchlist.png"),
      fullPage: true,
    });
    await rail
      .getByRole("region", { name: "Sygnały" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    await dialog.getByRole("button", { name: "dziennik" }).click();
    const journal = page.getByTestId("native-signals-journal");
    await expect(journal).toBeVisible();
    // The instrument filter lists the instruments by their label (old Journal `names`).
    const only = journal.getByRole("combobox", { name: "Instrument" });
    const watchValue = await only
      .locator("option", { hasText: "WATCH" })
      .first()
      .getAttribute("value");
    await only.selectOption(watchValue ?? "");
    await expect(journal).toContainText("Synthetic decision99");
    // The newest decision is the first entry; its `cofnij` works for 15 minutes.
    await journal.getByRole("button", { name: "cofnij" }).first().click();
    await expect(journal).not.toContainText("Synthetic decision99");
    const privacy = page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true });
    await privacy.click();
    await test.info().attach("privacy-transition-scalar", {
      body: Buffer.from(
        JSON.stringify(
          await page.evaluate(() => ({
            route: `${location.pathname}${location.search}${location.hash}`,
            journal: document.querySelector('[data-testid="native-signals-journal"]') !== null,
            portfolio: document.querySelector('[data-testid="native-portfolio"]') !== null,
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
    // The native signals read answers `unavailable: privacy` (data-map GAP-6): the page stays, without rows.
    await expect(page.getByTestId("native-signals-journal")).toBeVisible();
    await expect(page.getByTestId("native-signals-journal")).not.toContainText(
      "Synthetic watched chance",
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
