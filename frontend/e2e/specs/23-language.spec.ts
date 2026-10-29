// UI language: Settings › Aplikacja › Język switches the app to English (reload), the backend renders its
// texts in English too (X-Cashu-Lang), and "Systemowy" goes back to the browser language (pl-PL here).
import type { Page } from "@playwright/test";
import { ANNA, expect, go, openSettings, tab, test } from "../fixtures";

/** A top-level tab while the UI is in English (the nav is "Modules" there). */
const tabEn = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Modules" }).getByRole("button", { name, exact: true });

test("switch to English and back to the system language", async ({ app: page }) => {
  await go(page, `${ANNA}/overview`);
  await openSettings(page);
  const app = page.getByRole("region", { name: "Aplikacja", exact: true });
  await app.getByRole("group", { name: "Język" }).getByRole("button", { name: "English", exact: true }).click();

  await expect(tabEn(page, "Overview")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  for (const label of ["Profile", "Modules", "App"]) {
    await expect(nav.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  // a backend-rendered label (GET /api/modules) in English
  await expect(page.getByRole("region", { name: "Modules", exact: true }).getByText("Home budget").first()).toBeVisible();

  const appEn = page.getByRole("region", { name: "App", exact: true });
  await appEn.getByRole("group", { name: "Language" }).getByRole("button", { name: "System", exact: true }).click();
  await expect(tab(page, "Przegląd")).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("lang", "pl");
});
