// Research: dismiss a note and bring it back with the toast's "Cofnij"; dismiss a candidate and restore
// it with its "przywróć" link (server restore window).
import { ANNA, expect, go, test, toasts } from "../fixtures";

test("research note dismiss and undo", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio/research`);
  const title = "Rynek oczekuje stabilnych stóp procentowych";
  const note = page.locator("article[data-note]", { hasText: title });
  await expect(note).toBeVisible();
  await note.getByRole("button", { name: `Odrzuć notatkę: ${title}` }).click();
  const toast = toasts(page).locator(".toast", { hasText: "Notatka odrzucona" });
  await expect(toast).toBeVisible();
  await expect(note).toBeHidden();
  await toast.getByRole("button", { name: "Cofnij" }).click();
  await expect(toasts(page)).toContainText("Cofnięto: odrzucenie notatki");
  await expect(note.getByRole("button", { name: `Odrzuć notatkę: ${title}` })).toBeVisible();
});

test("research candidate dismiss and restore", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio/research`);
  const card = page.locator(".cand[data-note]", { hasText: "Demo Infrastructure UCITS ETF" });
  await expect(card).toBeVisible();
  await card.getByRole("button", { name: "Odrzuć" }).click();
  await expect(toasts(page)).toContainText("Odrzucono kandydata");
  await expect(card).toContainText("odrzucony");
  await card.getByRole("button", { name: "przywróć" }).click();
  await expect(toasts(page)).toContainText("Przywrócono kandydata");
  await expect(card.getByRole("button", { name: "Odrzuć" })).toBeVisible();
});
