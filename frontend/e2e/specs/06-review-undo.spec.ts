// Weekly review: the card deck, walked to the summary and closed as done, undone with the "cofnij" link next
// to the hero's review button (F7 FE14), then again with the toast's "Cofnij".
import type { Locator, Page } from "@playwright/test";
import { ANNA, expect, go, test, toasts } from "../fixtures";

/** Swipe right ("Jasne, dalej") through every card until the summary shows. */
async function toSummary(review: Locator): Promise<void> {
  const note = review.getByLabel("Notatka z przeglądu");
  for (let k = 0; k < 10 && !(await note.isVisible()); k++) {
    await review.getByRole("button", { name: "Jasne, dalej" }).click();
    await review.page().waitForTimeout(350);
  }
  await expect(note).toBeVisible();
}

async function finishReview(page: Page, note: string): Promise<void> {
  await go(page, `${ANNA}/investments.portfolio`);
  await page.getByRole("button", { name: /^Przegląd tygodnia/ }).click();
  const review = page.getByRole("dialog", { name: "Przegląd tygodnia" });
  await expect(review.getByText("Czy świat się wali")).toBeVisible();
  await toSummary(review);
  await review.getByLabel("Notatka z przeglądu").fill(note);
  await review.getByRole("button", { name: "Zamknij przegląd", exact: true }).click();
  await expect(page.getByRole("button", { name: /zrobiony/ })).toBeVisible();
  await expect(review).toBeHidden();
}

test("review done, undone with the cofnij link", async ({ app: page }) => {
  await finishReview(page, "E2E przegląd");
  await page.getByRole("button", { name: "cofnij", exact: true }).click();
  await expect(toasts(page)).toContainText("Cofnięto: przegląd");
  const review = page.getByRole("dialog", { name: "Przegląd tygodnia" });
  await expect(review).toBeVisible();
  await toSummary(review);
  await expect(review.getByLabel("Notatka z przeglądu")).toHaveValue("E2E przegląd");
  await review.getByRole("button", { name: "Zamknij przegląd", exact: true }).click();
});

test("review done, undone with the toast", async ({ app: page }) => {
  await finishReview(page, "E2E toast");
  await toasts(page).getByRole("button", { name: "Cofnij" }).first().click();
  await expect(toasts(page)).toContainText("Cofnięto: przegląd");
  // Undone: the review is open again (the deck comes back over the home).
  await expect(page.getByRole("dialog", { name: "Przegląd tygodnia" })).toBeVisible();
});
