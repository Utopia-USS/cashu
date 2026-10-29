// Approving the agent's pending import proposal (a 4 000 zł deposit plus one buy) updates the net worth on
// Przegląd without a reload (F7 FE7).
import type { Page } from "@playwright/test";
import { ANNA, expect, go, plNumber, test, toasts, tab } from "../fixtures";

const netWorth = async (page: Page) =>
  plNumber(await page.getByRole("region", { name: "Wartość netto", exact: true }).locator(".h1 .v").innerText());

test("approving an import proposal refreshes Przegląd", async ({ app: page }) => {
  await go(page, `${ANNA}/overview`);
  await expect(page.getByRole("region", { name: "Wartość netto", exact: true })).toContainText("zł");
  const before = await netWorth(page);

  await tab(page, "Inwestycje").click();
  // The pending proposal waits on the review deck's "Do decyzji" card; "Zobacz" opens it over the home.
  await page.getByRole("button", { name: /^Przegląd tygodnia/ }).click();
  const review = page.getByRole("dialog", { name: "Przegląd tygodnia" });
  const open = review.getByRole("button", { name: "Zobacz" });
  await expect(review.getByText("Czy świat się wali")).toBeVisible();
  for (let k = 0; k < 8 && !(await open.isVisible()); k++) {
    await review.getByRole("button", { name: "Jasne, dalej" }).click();
    await page.waitForTimeout(350);
  }
  await expect(review.getByText(/Propozycja agenta/)).toBeVisible();
  await open.click();
  await page.getByRole("button", { name: "Zatwierdź import" }).click();
  await expect(toasts(page)).toContainText("Zatwierdzono propozycję");
  for (let k = 0; k < 3 && (await page.locator(".rd").count()); k++) await page.keyboard.press("Escape");
  await expect(page.locator(".rd")).toHaveCount(0);

  await tab(page, "Przegląd").click();
  await expect.poll(() => netWorth(page), { timeout: 15_000 }).toBeGreaterThan(before + 3000);
});
