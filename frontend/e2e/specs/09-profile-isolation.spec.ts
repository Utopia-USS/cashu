// Profile switch: data of Demo Anna never shows in Demo Piotr (overview, investments, alerts, research)
// and switching back shows Anna's data again.
import { ANNA, expect, go, PIOTR, test } from "../fixtures";

const ANNA_ONLY = ["Mieszkanie Demo", "Kredyt hipoteczny Demo", "Samochód Demo"];
const PIOTR_ONLY = ["Kredyt samochodowy Demo", "Auto Demo"];

test("switching profiles isolates their data", async ({ app: page }) => {
  await go(page, `${ANNA}/overview`);
  for (const t of ANNA_ONLY) await expect(page.getByText(t, { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: /Demo Anna/ }).first().click();
  await page.getByRole("menu", { name: "Profile" }).getByRole("menuitem", { name: /Demo Piotr/ }).click();
  await expect(page).toHaveURL(new RegExp(`#/${PIOTR}/`));
  await expect(page.getByRole("button", { name: /Demo Piotr/ }).first()).toBeVisible();
  for (const t of PIOTR_ONLY) await expect(page.getByText(t, { exact: true }).first()).toBeVisible();
  for (const t of ANNA_ONLY) await expect(page.getByText(t, { exact: true })).toHaveCount(0);

  await go(page, `${PIOTR}/investments.portfolio`);
  await expect(page.getByText("Demo Bank Polski SA").first()).toBeVisible();
  await expect(page.getByText("Demo Energia SA")).toHaveCount(0);
  await expect(page.getByText("Demo Wodociągi SA")).toHaveCount(0);
  await expect(page.getByText("Demo Energia poniżej poziomu")).toHaveCount(0);

  await go(page, `${PIOTR}/investments.portfolio/alerts`);
  await expect(page.getByRole("row", { name: /Demo US Technology powyżej poziomu/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Udział ETF globalnego/ })).toHaveCount(0);

  await go(page, `${PIOTR}/investments.portfolio/research`);
  await expect(page.locator("article[data-note]", { hasText: "DMBK" }).first()).toBeVisible();
  await expect(page.locator("article[data-note]", { hasText: "GLBA: napływy" })).toHaveCount(0);

  await page.getByRole("button", { name: /Demo Piotr/ }).first().click();
  await page.getByRole("menu", { name: "Profile" }).getByRole("menuitem", { name: /Demo Anna/ }).click();
  await go(page, `${ANNA}/overview`);
  await expect(page.getByText("Mieszkanie Demo", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Kredyt samochodowy Demo", { exact: true })).toHaveCount(0);
});
