// Model recommendations are generated outside the dashboard. The dashboard shows them on the asset tile and
// in the Rekomendacja card under Teza, but never presents an editor; the owner's decision remains a separate action.
import { ANNA, expect, go, test } from "../fixtures";

const NAME = /^Demo Global Equity/;

test("model recommendation: held asset shows it without an editor", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const assets = page.getByRole("region", { name: "Aktywa" });
  const row = assets.locator("tr.rowlink", { hasText: "GLBA" }).first();
  await expect(row.locator(".avw[data-plan='hold'] svg.pl")).toHaveCount(1);
  await row.click();
  const drawer = page.getByRole("dialog", { name: NAME });
  const head = drawer.locator(".ahead");
  const recommendation = drawer.getByLabel("Rekomendacja modelu: trzymaj");
  await expect(recommendation).toBeVisible();
  await expect(recommendation).toContainText("Teza pozostaje aktualna, a pozycja mieści się w docelowej konstrukcji portfela.");
  await expect(head.locator(".avw[data-plan='hold']")).toBeVisible();
  await expect(recommendation).not.toHaveAttribute("role", "button");
  await expect(drawer.getByRole("button", { name: /^Plan/ })).toHaveCount(0);
  await expect(head.getByRole("button", { name: "Zanotuj decyzję" })).toBeVisible();
});

test("model recommendation: watched asset shows it without a menu", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const assets = page.getByRole("region", { name: "Aktywa" });
  await assets.getByRole("button", { name: /^Obserwowane/ }).click();
  const row = assets.locator("tr.rowlink").first();
  await expect(row.locator(".avw[data-plan='buy'] svg.pl")).toHaveCount(1);
  await row.click();
  const recommendation = page.locator(".adrawer").getByLabel("Rekomendacja modelu: kup");
  await expect(recommendation).toBeVisible();
  await expect(recommendation).toContainText("Kandydat pasuje do strategii; przed zakupem model czeka na potwierdzenie warunków wejścia.");
  await expect(page.getByRole("menu", { name: "Plan" })).toHaveCount(0);
});
