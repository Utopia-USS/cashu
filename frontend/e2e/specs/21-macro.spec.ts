// P6 macro regimes ("Makro"): the research page shows five regime cards, a card filters Notatki by its macro
// note key (chip `Makro · …`, `?segment=macro_<key>` written to the URL, kept on reload), the chip clears both; the
// home research strip's Makro column (P7) shows five regime rows with a summary each, the explain popover on
// focus, and a title opens the research page with the same filter.
// Demo Anna has synthetic macro closes for ~2 years and one macro note on the dollar regime.
import { ANNA, expect, go, test } from "../fixtures";

test("macro: five regime cards; a card filters the notes by its macro key and the chip clears it", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio/research`);
  const widget = page.locator("#rsch-macro");
  const cards = widget.locator(".mc");
  await expect(cards).toHaveCount(5);
  await expect(widget.locator(".mc .mh button.t")).toHaveText(["Rynek akcji", "Dolar", "Rynki wschodzące", "Surowce", "Obligacje i stopy"]);
  // Every card has its state tag; the demo series are long enough for every regime (no `brak danych`).
  for (let i = 0; i < 5; i++) await expect(cards.nth(i).locator(".st .tag").first()).toBeVisible();
  await expect(widget.locator(".mc.off")).toHaveCount(0);
  await expect(widget.locator(".mc .st .tag.pos, .mc .st .tag.neg, .mc .st .tag.warn").first()).toBeVisible();
  await expect(widget.locator(".wh .tag", { hasText: /^stan \d{1,2}\.\d{2}$/ })).toBeVisible();

  const notes = page.locator("#rsch-notes");
  const title = "Dolar: indeks DXY po posiedzeniu Fed";
  await widget.locator('.mc[data-macro="dollar"] button.t').click();
  await expect(page.locator('.mc[data-macro="dollar"]')).toHaveClass(/\bsel\b/);
  const chip = notes.getByRole("button", { name: "Makro · Dolar ✕" });
  await expect(chip).toBeVisible();
  const note = page.locator("article[data-note]", { hasText: title });
  await expect(note).toBeVisible();
  await expect(note.locator(".who")).toContainText("Dolar");
  await expect(note.locator(".who .sym")).toHaveText("makro");
  // Only the dollar's notes are listed.
  await expect(notes.locator("article[data-note]")).toHaveCount(1);
  // The selection is in the URL (replaced in place) and survives a reload.
  await expect(page).toHaveURL(/research\?segment=macro_dollar$/);
  await page.reload();
  await expect(page.locator('.mc[data-macro="dollar"]')).toHaveClass(/\bsel\b/);
  await expect(notes.getByRole("button", { name: "Makro · Dolar ✕" })).toBeVisible();
  await expect(note).toBeVisible();

  await chip.click();
  await expect(page).toHaveURL(/research$/);
  await expect(notes.getByRole("button", { name: /Makro · Dolar ✕/ })).toHaveCount(0);
  await expect(page.locator('.mc[data-macro="dollar"]')).not.toHaveClass(/\bsel\b/);
  expect(await notes.locator("article[data-note]").count()).toBeGreaterThan(1);
});

test("macro: the home Makro column shows five rows with a summary; focus opens the explanation; a title filters", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const strip = page.locator("#inv-research");
  const rows = strip.locator(".mrows .mrow");
  await expect(rows).toHaveCount(5);
  await expect(rows.first().locator("button.t")).toHaveText("Rynek akcji");
  await expect(rows.first().locator(".sum")).not.toBeEmpty();
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
  await last.locator("button.t").click();
  await expect(page).toHaveURL(/research\?segment=macro_rates/);
  await expect(page.locator("#rsch-notes").getByRole("button", { name: "Makro · Obligacje i stopy ✕" })).toBeVisible();
  // The dollar row opens its note.
  await go(page, `${ANNA}/investments.portfolio`);
  await strip.locator('.mrow[data-macro="dollar"] button.t').click();
  await expect(page).toHaveURL(/research\?segment=macro_dollar/);
  await expect(page.locator("article[data-note]", { hasText: "Dolar: indeks DXY po posiedzeniu Fed" })).toBeVisible();
});
