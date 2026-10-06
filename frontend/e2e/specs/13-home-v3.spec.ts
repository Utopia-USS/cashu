// Inwestycje home v3 (design/v3/home-v3/home-v3.md rev 2 + owner F8 Q17-Q19): Alokacja's Rachunki view, Aktywa
// sorted by Wynik %, the Obserwowane tab, the rail's Portfel section (a row click opens the subject, the trailing
// icon button opens the row menu), the
// hero facts Obsunięcie / Wpłaty, and no `wyzwol*` word on the home or the alerts manager.
import { ANNA, expect, go, plNumber, test, toasts } from "../fixtures";

test("home v3: Rachunki view, Wynik % sort, Obserwowane tab, hero facts", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const hero = page.getByRole("region", { name: "Wartość portfela" });
  await expect(hero).toContainText("Obsunięcie");
  await expect(hero).toContainText("Wpłaty");
  // Q19: no next deposit date, no recovery time in the hero
  await expect(hero).not.toContainText(/Następna|odrobione/);
  await expect(page.locator("#inv-dd")).toHaveCount(0);
  await expect(page.locator("#inv-contrib")).toHaveCount(0);

  const alloc = page.getByRole("region", { name: "Alokacja" });
  await alloc.getByRole("button", { name: "Rachunki", exact: true }).click();
  await expect(alloc.getByRole("button", { name: "+ Rachunek" })).toBeVisible();
  await expect(alloc.locator(".arow:not(.head)").first()).toBeVisible();

  const assets = page.getByRole("region", { name: "Aktywa" });
  await expect(assets.getByLabel("Sortowanie")).toHaveValue("result");
  const pcts = await assets.locator("tbody tr.rowlink td:last-child").allInnerTexts();
  const values = pcts.map((t) => { try { return plNumber(t); } catch { return NaN; } }).filter((v) => Number.isFinite(v));
  expect(values.length).toBeGreaterThan(1);
  expect([...values].sort((a, b) => b - a)).toEqual(values);

  await assets.getByRole("button", { name: /^Obserwowane \d+$/ }).click();
  await expect(assets.getByText("Demo Wodociągi SA")).toBeVisible();
  await expect(assets.getByRole("columnheader", { name: "Alerty" })).toBeVisible();
  await expect(assets.getByRole("button", { name: "+ Dodaj" })).toBeVisible();
});

test("home v3: no wyzwol words on the home and the alerts manager (Q3)", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  await expect(page.getByRole("region", { name: "Sygnały" })).toBeVisible();
  await expect(page.getByText(/wyzwol/i)).toHaveCount(0);
  await go(page, `${ANNA}/investments.portfolio/alerts`);
  await expect(page.getByRole("button", { name: /^Czekają · \d+$/ })).toBeVisible();
  await expect(page.getByText(/wyzwol/i)).toHaveCount(0);
});

test("home v3: rail sections, a row click opens the subject, the trailing button opens the menu (Q17)", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const rail = page.getByRole("region", { name: "Sygnały" });
  await expect(rail.locator(".polh", { hasText: "Portfel" })).toBeVisible();
  const row = rail.locator(".sig.cmp.row").first();
  await expect(row).toBeVisible();
  // one button on a rail row: the trailing menu button
  const more = row.getByRole("button", { name: /^Akcje: / });
  await expect(row.getByRole("button")).toHaveCount(1);
  await more.click();
  const menu = page.getByRole("menu");
  await expect(menu.getByRole("menuitem", { name: "Zanotuj" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: /^Potwierdź/ })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Wszystkie" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Otwórz" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(more).toBeFocused();
  // Enter on the focused menu button opens it again; Zanotuj turns the menu into the decision form
  await page.keyboard.press("Enter");
  await page.getByRole("menuitem", { name: "Zanotuj" }).click();
  await expect(page.getByLabel("Powód decyzji")).toBeVisible();
  await page.getByRole("button", { name: "Zwiń" }).click();
  await expect(page.getByLabel("Powód decyzji")).toBeHidden();
  // Wszystkie from the menu opens the dialog
  await more.click();
  await page.getByRole("menuitem", { name: "Wszystkie" }).click();
  const dialog = page.getByRole("dialog", { name: "Sygnały" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // a click on the row itself opens the subject: an instrument's asset page, else the dialog at the signal
  const instrumentRow = rail.locator(".sig.cmp.row", { has: page.locator(".il") }).first();
  await instrumentRow.locator(".mn").click();
  await expect(page).toHaveURL(/\/assets\/\d+/);
});

test("home v3: an outside click leaves focus where it landed; Potwierdź writes the row and one Cofnij restores it", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const rail = page.getByRole("region", { name: "Sygnały" });
  const row = rail.locator(".sig.cmp.row").first();
  const key = await row.getAttribute("data-group");
  const more = row.getByRole("button", { name: /^Akcje: / });
  // F8 review FE-4: a click elsewhere closes the menu without pulling focus back to the row
  await more.click();
  await expect(page.getByRole("menu")).toBeVisible();
  const sort = page.getByRole("region", { name: "Aktywa" }).getByLabel("Sortowanie");
  await sort.click();
  await expect(page.getByRole("menu")).toBeHidden();
  await page.waitForTimeout(100);
  await expect(sort).toBeFocused();
  await page.keyboard.press("Escape");
  // Potwierdź acknowledges every live signal of the row; one Cofnij undoes all of them
  await more.click();
  await page.getByRole("menu").getByRole("menuitem", { name: /^Potwierdź/ }).click();
  const toast = toasts(page).locator(".toast", { hasText: "Potwierdzone bez zmian" });
  await expect(toast).toBeVisible();
  await expect(rail.locator(`.sig.cmp.row[data-group="${key}"]`)).toHaveCount(0);
  await toast.getByRole("button", { name: "Cofnij" }).click();
  await expect(toasts(page)).toContainText("Cofnięto: potwierdzenie");
  await expect(rail.locator(`.sig.cmp.row[data-group="${key}"]`)).toHaveCount(1);
});

test("home v3: opening a theme marks its research notes read (Q10)", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const strip = page.locator("#inv-research");
  const chip = strip.locator(".rs-un");
  await expect(chip).toBeVisible();
  const before = Number(await chip.innerText());
  await go(page, `${ANNA}/investments.portfolio/research?theme=${encodeURIComponent("stopy procentowe")}`);
  await expect(page.locator("article[data-note]", { hasText: "Rynek oczekuje stabilnych stóp procentowych" })).toBeVisible();
  await go(page, `${ANNA}/investments.portfolio`);
  if (before > 1) await expect(strip.locator(".rs-un")).toHaveText(String(before - 1));
  else await expect(strip.locator(".rs-un")).toHaveCount(0);
});
