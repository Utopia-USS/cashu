// Shared helpers: open the app with the one-time token (PK1: fragment -> sessionStorage), go to a hash
// route, read figures, find toasts.
import { expect, test as base, type Locator, type Page } from "@playwright/test";

export const ANNA = "demo-anna";
export const PIOTR = "demo-piotr";

export function serverUrl(): string {
  const url = process.env.E2E_BASE_URL;
  if (!url) throw new Error("E2E_BASE_URL is not set (global setup did not run)");
  return url;
}

/** Open the app in this tab with the token fragment, then the hash route (e.g. `demo-anna/overview`). */
export async function openApp(page: Page, route?: string): Promise<void> {
  await page.goto(`${serverUrl()}/#token=${process.env.E2E_TOKEN}`);
  await expect(tab(page, "Ustawienia")).toBeVisible();
  if (route) await go(page, route);
}

/** Navigate inside the SPA (hash router) without reloading the page. */
export async function go(page: Page, route: string): Promise<void> {
  await page.evaluate((r) => { location.hash = `#/${r}`; }, route);
  await expect(page).toHaveURL(new RegExp(`#/${route.replace(/[.?]/g, "\\$&")}`));
}

/** The toast stack (role region "Powiadomienia"). */
export const toasts = (page: Page): Locator => page.getByRole("region", { name: "Powiadomienia" });

/** "60 105,31 zł" / "-1 234 zł" -> number (Polish formatting, any space kind). */
export function plNumber(text: string): number {
  const m = text.replace(/[\s\u00a0\u202f]/g, "").match(/-?\d+(?:,\d+)?/);
  if (!m) throw new Error(`no number in "${text}"`);
  return Number(m[0].replace(",", "."));
}

export const test = base.extend<{ app: Page }>({
  app: async ({ page }, use) => {
    await openApp(page);
    await use(page);
  },
});
export { expect };

/** A top-level tab (navigation "Moduły": Przegląd, Wydatki, ..., Inwestycje, Ustawienia). */
export const tab = (page: Page, name: string): Locator =>
  page.getByRole("navigation", { name: "Moduły" }).getByRole("button", { name, exact: true });
