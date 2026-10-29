// P6 macro regimes, P9 briefs, as a story: the home research strip shows the five regimes as chips (state +
// name); a click explains the regime in a sentence and "więcej" opens the regime's drawer (its state and notes) over
// the home. The research page has no Makro widget and an old `?segment=macro_<key>` link opens the plain page. Demo
// Anna has synthetic macro closes for ~2 years and one macro note on the dollar regime.
import { ANNA, expect, go, test } from "../fixtures";

test("macro: the research page has no Makro widget; an old ?segment= link opens the plain page", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio/research?segment=macro_dollar`);
  await expect(page.locator(".st-head .st-story")).not.toBeEmpty();
  await expect(page).toHaveURL(/research$/);
  await expect(page.locator("#rsch-macro")).toHaveCount(0);
  await expect(page.locator("#rsch-segments")).toHaveCount(0);
  await expect(page.locator(".mc")).toHaveCount(0);
  // every note is listed on the Notatki tab (no filter): the dollar note and others
  await page.getByRole("tab", { name: "Notatki" }).click();
  await expect(page.locator("article[data-note]", { hasText: "Dolar: indeks DXY po posiedzeniu Fed" })).toBeVisible();
  expect(await page.locator("#rsch-notes article[data-note]").count()).toBeGreaterThan(1);
});

test("macro: the home strip shows five regime chips; a chip explains, więcej opens the drawer", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const strip = page.locator("#inv-research");
  const chips = strip.locator(".st-chips [data-macro]");
  await expect(chips).toHaveCount(5);
  await expect(chips.first()).toContainText("Rynek akcji");
  for (let i = 0; i < 5; i++) await expect(chips.nth(i).locator(".st-mood")).not.toBeEmpty();
  const dollar = strip.locator('.st-chips [data-macro="dollar"]');
  await expect(strip.locator(".st-mexp")).toHaveCount(0);
  await dollar.click();
  await expect(dollar).toHaveAttribute("aria-expanded", "true");
  await expect(strip.locator(".st-mexp")).not.toBeEmpty();
  await strip.locator(".st-mexp").getByRole("button", { name: "więcej →" }).click();
  await expect(page).toHaveURL(/investments\.portfolio\/topics\/macro_dollar$/);
  const drawer = page.getByRole("dialog", { name: "Dolar" });
  await expect(drawer.locator("#topic-regime")).toBeVisible();
  await expect(drawer.locator("#topic-regime .bh")).not.toBeEmpty();
  await expect(drawer.locator("#topic-notes article[data-note]", { hasText: "Dolar: indeks DXY po posiedzeniu Fed" })).toBeVisible();
  await expect(drawer.locator("#topic-thesis")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});
