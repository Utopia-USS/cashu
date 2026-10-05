// Weekly review: open it, close it as done, undo with the "cofnij" link next to "Przegląd zrobiony"
// (F7 FE14), then again with the toast's "Cofnij".
import type { Page } from "@playwright/test";
import { ANNA, expect, go, test, toasts } from "../fixtures";

async function finishReview(page: Page, note: string): Promise<void> {
  await go(page, `${ANNA}/investments.portfolio`);
  await page.getByRole("button", { name: /^Przegląd tygodnia/ }).click();
  const review = page.getByRole("region", { name: "Przegląd tygodnia" });
  await expect(review.getByRole("group", { name: "Kroki przeglądu" })).toBeVisible();
  await review.getByLabel("Notatka z przeglądu").fill(note);
  await review.getByRole("button", { name: "Zamknij przegląd" }).click();
  await expect(page.getByRole("button", { name: /^Przegląd zrobiony/ })).toBeVisible();
  await expect(review).toBeHidden();
}

test("review done, undone with the cofnij link", async ({ app: page }) => {
  await finishReview(page, "E2E przegląd");
  await page.getByRole("button", { name: "cofnij", exact: true }).click();
  await expect(toasts(page)).toContainText("Cofnięto: przegląd");
  const review = page.getByRole("region", { name: "Przegląd tygodnia" });
  await expect(review).toBeVisible();
  await expect(review.getByLabel("Notatka z przeglądu")).toHaveValue("E2E przegląd");
  await page.getByRole("button", { name: "Zamknij przegląd" }).first().click();
});

test("review done, undone with the toast", async ({ app: page }) => {
  await finishReview(page, "E2E toast");
  await toasts(page).getByRole("button", { name: "Cofnij" }).first().click();
  await expect(toasts(page)).toContainText("Cofnięto: przegląd");
  await expect(page.getByRole("button", { name: /^Przegląd zrobiony/ })).toBeHidden();
});
