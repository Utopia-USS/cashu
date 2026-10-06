// Investments home renders from the demo data; "Synchronizuj" refreshes the value chart with the hero
// (F7 FE7: the chart's last point equals the hero value after a run that adds a new bar).
import type { Page } from "@playwright/test";
import { ANNA, expect, go, plNumber, test } from "../fixtures";

const heroValue = async (page: Page) =>
  plNumber(await page.getByRole("region", { name: "Wartość portfela" }).locator(".h1 .v").innerText());
const chartValue = async (page: Page) =>
  plNumber((await page.locator("#inv-value").getByText(/^portfel\s+\d/).textContent()) ?? "");

test("investments home renders hero, signals, alerts, research, chart", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const hero = page.getByRole("region", { name: "Wartość portfela" });
  await expect(hero).toContainText("zł");
  expect(await heroValue(page)).toBeGreaterThan(10_000);
  await expect(page.locator("[data-signal]").first()).toBeVisible();
  await expect(page.getByText("Demo Global Equity UCITS ETF").first()).toBeVisible();
  await expect(page.getByText("Demo Energia poniżej poziomu")).toBeVisible();
  // home v3 (Q6): the watchlist is the Obserwowane tab of Aktywa.
  const assets = page.getByRole("region", { name: "Aktywa" });
  await assets.getByRole("button", { name: /^Obserwowane \d+$/ }).click();
  await expect(assets.getByText("Demo Wodociągi SA")).toBeVisible();
  // The benchmark by its name, never the strategy id (F7 GF7).
  await expect(page.locator("#inv-value")).toContainText("MSCI ACWI");
  await expect(page.locator("#inv-value")).not.toContainText("msci_acwi");
  await expect(page.locator("#inv-value").getByText(/^portfel\s+\d/)).toBeVisible();
});

test("Synchronizuj: the value chart follows the hero", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  await expect(page.locator("#inv-value").getByText(/^portfel\s+\d/)).toBeVisible();
  const before = await heroValue(page);
  expect(Math.abs(Math.round(before) - (await chartValue(page)))).toBeLessThanOrEqual(1);

  const run = page.getByRole("button", { name: "↻ Synchronizuj" });
  await run.click();
  await expect(run).toBeEnabled({ timeout: 30_000 });
  // The run fetched one more session (synthetic source): the hero moves, the chart must follow.
  await expect.poll(() => heroValue(page), { timeout: 15_000 }).not.toBe(before);
  const after = await heroValue(page);
  await expect.poll(async () => Math.abs(Math.round(after) - (await chartValue(page))), { timeout: 15_000 }).toBeLessThanOrEqual(1);
});
