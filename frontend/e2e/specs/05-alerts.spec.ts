// Alerts: create a price alert, delete it, restore it with the toast's "Cofnij" (same alert comes back);
// deleting and restoring an agent alert keeps its agent source (F7 FE3).
import { ANNA, expect, go, test, toasts } from "../fixtures";

const TITLE = "E2E alert ceny GLBA";

test("alert create, delete and restore", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio/alerts`);
  const form = page.getByRole("region", { name: "Nowy alert" });
  await form.locator("#af-inst").fill("GLBA");
  await form.getByRole("radio", { name: /Cena powyżej/ }).click();
  await form.getByLabel(/^Poziom/).fill("999");
  await form.getByLabel("Tytuł").fill(TITLE);
  await form.getByRole("button", { name: "Utwórz" }).click();
  await expect(toasts(page)).toContainText(`Utworzono alert „${TITLE}"`);
  const row = page.getByRole("row", { name: new RegExp(TITLE) });
  await expect(row).toBeVisible();

  await page.getByRole("button", { name: `Usuń alert ${TITLE}` }).click();
  const toast = toasts(page).locator(".toast", { hasText: `Usunięto alert „${TITLE}"` });
  await expect(toast).toBeVisible();
  await expect(row).toBeHidden();
  await toast.getByRole("button", { name: "Cofnij" }).click();
  await expect(row).toBeVisible();
  await expect(row.getByRole("cell", { name: "ty", exact: true })).toBeVisible();
});

test("agent alert delete and restore keeps the agent source", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio/alerts`);
  const title = "Duży ruch ETF globalnego";
  const row = page.getByRole("row", { name: new RegExp(title) });
  await expect(row).toContainText("agent");
  await page.getByRole("button", { name: `Usuń alert ${title}` }).click();
  await expect(row).toBeHidden();
  await toasts(page).locator(".toast", { hasText: title }).getByRole("button", { name: "Cofnij" }).click();
  await expect(row).toBeVisible();
  await expect(row).toContainText("agent");
  await expect(toasts(page)).not.toContainText("wraca jako");
});
