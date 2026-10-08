// P6 macro regimes ("Makro"): the research page shows five regime cards, a card filters Notatki by its macro
// note key (chip `Makro · …`, `?segment=macro_<key>` written to the URL, kept on reload), the chip clears both; the
// home research strip shows the five
// state words at the top of the Rynek column and a word opens the research page with the same filter.
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

test("macro: the home line shows five state words and a word opens the research page filtered", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const strip = page.locator("#inv-research");
  const words = strip.locator(".mline .ml button");
  await expect(words).toHaveCount(5);
  // The Makro header precedes the Rynek header in the same column.
  await expect(strip.locator(".rsch3 > div").nth(1).locator(".rsec").first()).toContainText("Makro");
  await expect(words.nth(1)).toHaveAttribute("title", /^Dolar/);
  await words.nth(1).click();
  await expect(page).toHaveURL(/research\?segment=macro_dollar/);
  await expect(page.locator("#rsch-notes").getByRole("button", { name: "Makro · Dolar ✕" })).toBeVisible();
  await expect(page.locator("article[data-note]", { hasText: "Dolar: indeks DXY po posiedzeniu Fed" })).toBeVisible();
});
