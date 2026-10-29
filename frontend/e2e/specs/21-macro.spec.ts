// P6 macro regimes ("Makro"), P9 briefs: the home research strip's Makro column shows five regime rows, each with the
// brief headline (or the plain sentence before the first brief), the explain popover on focus / hover, and a title
// opens the regime's drawer (its state and notes) over the home. The research page has no Makro widget any more and an
// old `?segment=macro_<key>` link opens the plain page. Demo Anna has synthetic macro closes for ~2 years and one
// macro note on the dollar regime.
import { ANNA, expect, go, test } from "../fixtures";

test("macro: the research page has no Makro / Tematy widgets; an old ?segment= link opens the plain page", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio/research?segment=macro_dollar`);
  await expect(page.locator("#rsch-notes")).toBeVisible();
  await expect(page).toHaveURL(/research$/);
  await expect(page.locator("#rsch-macro")).toHaveCount(0);
  await expect(page.locator("#rsch-segments")).toHaveCount(0);
  await expect(page.locator(".mc")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Tematy · / })).toHaveCount(0);
  await expect(page.locator("#rsch-notes").getByRole("button", { name: /✕$/ })).toHaveCount(0);
  // every note is listed (no filter): the dollar note and others
  await expect(page.locator("article[data-note]", { hasText: "Dolar: indeks DXY po posiedzeniu Fed" })).toBeVisible();
  expect(await page.locator("#rsch-notes article[data-note]").count()).toBeGreaterThan(1);
});

test("macro: the home Makro column shows five rows with a plain headline; focus opens the explanation; a title opens the drawer", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const strip = page.locator("#inv-research");
  const rows = strip.locator(".mrows .mrow");
  await expect(rows).toHaveCount(5);
  await expect(rows.first().locator("button.t")).toHaveText("Rynek akcji");
  for (let i = 0; i < 5; i++) await expect(rows.nth(i).locator(".bh")).not.toBeEmpty();
  // `od <miesiąc rok>` next to the state
  await expect(rows.locator(".since", { hasText: /^od / }).first()).toHaveText(/^od (ponad|[a-ząćęłńóśźż]+ \d{4})/);
  // Keyboard focus on the fifth title shows its explanation popover (3-6 sentences).
  const last = rows.nth(4);
  const pop = last.locator(".mx");
  await expect(pop).toBeHidden();
  await last.locator("button.t").focus();
  await expect(pop).toBeVisible();
  expect((await pop.locator(".xt").innerText()).length).toBeGreaterThan(80);
  // Dismissible: Escape hides it while focus stays on the title (WCAG 1.4.13).
  await page.keyboard.press("Escape");
  await expect(pop).toBeHidden();
  await expect(last.locator("button.t")).toBeFocused();
  await last.locator("button.t").blur();
  // Hoverable: the pointer can rest on the first row's popover (it overlaps the next row) and Escape hides it too.
  const first = rows.first();
  const firstPop = first.locator(".mx");
  await first.locator("button.t").hover();
  await expect(firstPop).toBeVisible();
  await firstPop.locator(".xt").hover();
  await page.waitForTimeout(400);
  await expect(firstPop).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(firstPop).toBeHidden();
  await page.mouse.move(0, 0);
  // The dollar title opens the regime drawer with its note (no research page).
  await strip.locator('.mrow[data-macro="dollar"] button.t').click();
  await expect(page).toHaveURL(/investments\.portfolio\/topics\/macro_dollar$/);
  const drawer = page.getByRole("dialog", { name: "Dolar" });
  await expect(drawer.locator("#topic-regime")).toBeVisible();
  await expect(drawer.locator("#topic-regime .bh")).not.toBeEmpty();
  await expect(drawer.locator("#topic-notes article[data-note]", { hasText: "Dolar: indeks DXY po posiedzeniu Fed" })).toBeVisible();
  await expect(drawer.locator("#topic-thesis")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
});
