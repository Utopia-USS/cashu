// A decision on a signal, then undo: once with the row's "cofnij" link (browser in Europe/Warsaw, F7 FE1:
// the server's UTC timestamps keep the 15-minute window open) and once with the toast's "Cofnij". The flow
// runs in the signals dialog (`Wszystkie (n)` in the rail): the rail's compact rows drop a decided signal,
// the dialog keeps it quiet at the bottom with its "cofnij" link (signals-rail.md 2-3).
import type { Locator, Page } from "@playwright/test";
import { ANNA, expect, go, test, toasts } from "../fixtures";

async function decideOnFirstSignal(page: Page, reason: string): Promise<Locator> {
  await go(page, `${ANNA}/investments.portfolio`);
  await page.getByRole("region", { name: "Sygnały" }).getByRole("button", { name: /^Wszystkie \(\d+\)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Sygnały" });
  const first = dialog.locator("[data-signal]", { has: page.getByRole("button", { name: "Zanotuj decyzję" }) }).first();
  const id = await first.getAttribute("data-signal");
  const row = dialog.locator(`[data-signal="${id}"]`);
  await row.getByRole("button", { name: "Zanotuj decyzję" }).click();
  await row.getByLabel("Powód decyzji").fill(reason);
  await row.getByRole("button", { name: "Zapisz decyzję" }).click();
  await expect(toasts(page)).toContainText("Zapisano decyzję");
  await expect(row.getByRole("button", { name: "Zanotuj decyzję" })).toBeHidden();
  return row;
}

test("decision undone with the row link (Europe/Warsaw)", async ({ app: page }) => {
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("Europe/Warsaw");
  const row = await decideOnFirstSignal(page, "E2E: bez zmian");
  const undo = row.getByRole("button", { name: "cofnij", exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(toasts(page)).toContainText("Cofnięto: decyzja");
  await expect(row.getByRole("button", { name: "Zanotuj decyzję" })).toBeVisible();
});

test("decision undone with the toast", async ({ app: page }) => {
  const row = await decideOnFirstSignal(page, "E2E: toast");
  await toasts(page).locator(".toast", { hasText: "Zapisano decyzję" }).getByRole("button", { name: "Cofnij" }).click();
  await expect(toasts(page)).toContainText("Cofnięto: decyzja");
  await expect(row.getByRole("button", { name: "Zanotuj decyzję" })).toBeVisible();
});
