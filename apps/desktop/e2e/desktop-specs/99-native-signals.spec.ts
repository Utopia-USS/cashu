import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "../electron-test.ts";
import { openNativeDemo } from "../native-baseline.ts";

test("Signals: a decision from the signals dialog, the alerts manager and its CSV, the journal and incognito", async () => {
  const demo = await openNativeDemo({ env: { CASHU_E2E_SIGNALS: "1" } });
  const { app, page, dataDir } = demo;
  try {
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    const rail = page.getByTestId("native-portfolio");
    await expect(rail).toContainText("S55F");
    await rail
      .getByRole("region", { name: "Sygnały" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    const dialog = page.getByRole("dialog", { name: "Sygnały", exact: true });
    // The dialog lists every signal once.
    const signalIds = await dialog
      .locator("[data-signal]")
      .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-signal")));
    expect(signalIds.length).toBeGreaterThan(0);
    expect(new Set(signalIds).size).toBe(signalIds.length);
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

    // The alerts manager: mute, delete with the toast's undo, and the history CSV export.
    await rail
      .getByRole("region", { name: "Alerty" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    const alerts = page.getByTestId("native-signals-alerts");
    const title = "Synthetic Signals alert";
    const row = alerts.getByRole("row").filter({ hasText: title }).first();
    await alerts.getByRole("button", { name: `Wycisz alert ${title}` }).click();
    await expect(row).toContainText("wyciszony");
    await alerts.getByRole("button", { name: `Włącz alert ${title}` }).click();
    await expect(alerts.getByRole("button", { name: `Wycisz alert ${title}` })).toBeVisible();
    // No new-alert form: alerts come from the agent and the strategy.
    await expect(alerts.getByRole("region", { name: "Edycja alertu" })).toHaveCount(0);
    await alerts.getByRole("button", { name: `Usuń alert ${title}` }).click();
    await expect(alerts.getByRole("button", { name: `Usuń alert ${title}` })).toHaveCount(0);
    await page.getByRole("button", { name: "Cofnij" }).first().click();
    await expect(alerts.getByRole("button", { name: `Usuń alert ${title}` })).toBeVisible();
    const csvPath = join(dataDir, "native-signals-history.csv");
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
        app.evaluate(() => (globalThis as Record<string, unknown>).__signalsCsvDownload as string),
      )
      .toBe("completed");
    const csv = readFileSync(csvPath);
    expect(csv.subarray(0, 3).toString("hex")).toBe("efbbbf");
    expect(csv.toString("utf8")).toContain(title);

    // The journal shows the decision recorded above; its undo removes it.
    await alerts.getByRole("navigation").getByRole("button", { name: "Inwestycje" }).click();
    await rail
      .getByRole("region", { name: "Sygnały" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    await dialog.getByRole("button", { name: "dziennik" }).click();
    const journal = page.getByTestId("native-signals-journal");
    const only = journal.getByRole("combobox", { name: "Instrument" });
    const watchValue = await only
      .locator("option", { hasText: "WATCH" })
      .first()
      .getAttribute("value");
    await only.selectOption(watchValue ?? "");
    await expect(journal).toContainText("Synthetic decision99");
    await journal.getByRole("button", { name: "cofnij" }).first().click();
    await expect(journal).not.toContainText("Synthetic decision99");

    // Incognito hides only money: the journal stays and the signals are still listed.
    const incognito = page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true });
    await incognito.click();
    await expect(incognito).toBeChecked();
    await expect(journal).toBeVisible();
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    await expect(rail).toContainText("S55F");
    await rail
      .getByRole("region", { name: "Sygnały" })
      .getByRole("button", { name: /Wszystkie/u })
      .click();
    await expect(
      dialog.locator("[data-signal], [data-group]").filter({ hasText: "WATCH" }).first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await incognito.click();
    await expect(incognito).not.toBeChecked();
  } finally {
    await demo.close();
  }
});
