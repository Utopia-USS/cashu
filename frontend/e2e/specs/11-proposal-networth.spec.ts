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
  await page.getByRole("button", { name: /^Przegląd tygodnia/ }).click();
  const changes = page.getByRole("region", { name: "Co się zmieniło" });
  await expect(changes).toContainText("propozycja agenta");
  await changes.getByRole("button", { name: "zobacz" }).click();
  await page.getByRole("button", { name: "Zatwierdź import" }).click();
  await expect(toasts(page)).toContainText("Zatwierdzono propozycję");
  await page.getByRole("button", { name: "Zamknij przegląd" }).first().click();

  await tab(page, "Przegląd").click();
  await expect.poll(() => netWorth(page), { timeout: 15_000 }).toBeGreaterThan(before + 3000);
});
