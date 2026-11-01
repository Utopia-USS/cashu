// Inwestycje home v3 (design/v3/home-v3/home-v3.md rev 2 + owner F8 Q17-Q19): Alokacja's Rachunki view, Aktywa
// sorted by Wynik %, the Obserwowane tab, the rail next to the review deck (Sygnały rows open their subject, the
// review box opens the deck; Alerty only close or fired; Kandydaci with icon actions), the hero facts Obsunięcie /
// Wpłaty, and no `wyzwol*` word on the home or the alerts manager.
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

test("home rail: Sygnały rows open their subject, the review box opens the deck, Wszystkie the dialog", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const rail = page.getByRole("region", { name: "Sygnały" });
  await expect(rail.locator(".hlead")).not.toBeEmpty();
  await expect(rail.getByRole("button", { name: /^Akcje: / })).toHaveCount(0);
  // After a review closed by an earlier spec nothing is new and nothing was put off: no rows, only the lead.
  const rows = rail.locator(".hr-row.hr-link");
  const quiet = (await rows.count()) === 0;
  if (quiet) await expect(rail.locator(".hlead")).toContainText("Nic nowego od przeglądu");
  else {
    // one row grammar: a ticker tile, the bold subject, plain text; no row menu any more
    await expect(rows.first().locator(".il .av")).toBeVisible();
    await expect(rows.first().locator(".hr-tx b")).not.toBeEmpty();
  }
  // Wszystkie opens the full signals dialog
  await rail.getByRole("button", { name: /^Wszystkie \(\d+\)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Sygnały" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  // the review box (the review is due on fresh demo data) opens the deck
  const open = rail.getByRole("button", { name: "Otwórz przegląd" });
  if (await open.isVisible()) {
    await open.click();
    const review = page.getByRole("dialog", { name: "Przegląd tygodnia" });
    await expect(review).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(review).toBeHidden();
  }
  // a row of an instrument opens its asset page
  const instRow = rail.locator(".hr-row.hr-link", { hasNot: page.locator(".il.hr-pf") }).first();
  if (quiet || !(await instRow.count())) return;
  await instRow.locator(".hr-tx").click();
  await expect(page).toHaveURL(/\/assets\/\d+/);
});

test("home rail: Alerty shows only close or fired alerts with a tag; Kandydaci act by icons", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const alerts = page.getByRole("region", { name: "Alerty" });
  await expect(alerts.locator(".hlegend")).toBeVisible();
  for (const cls of await alerts.locator(".htag").evaluateAll((els) => els.map((e) => e.className))) expect(cls).toMatch(/\bhr-(near|met)\b/);
  await alerts.getByRole("button", { name: /^Wszystkie \(\d+\)$/ }).click();
  await expect(page).toHaveURL(/\/alerts$/);
  await go(page, `${ANNA}/investments.portfolio`);
  const cands = page.locator("#inv-candidates");
  const row = cands.locator(".hr-row").first();
  await expect(row).toBeVisible();
  await expect(row.getByRole("button", { name: /^Dlaczego .+ pasuje$/ })).toBeVisible();
  await expect(row.getByRole("button", { name: /^Obserwuj: / })).toBeVisible();
  await expect(row.getByRole("button", { name: /^Odrzuć: / })).toBeVisible();
  await row.getByRole("button", { name: /^Dlaczego .+ pasuje$/ }).click();
  await expect(cands.locator(".hr-why").first()).toBeVisible();
});

test("home v3: the research strip tells the week as a story; a topic opens its drawer (P9 drawer)", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const strip = page.locator("#inv-research");
  // One sentence on the market, the macro regimes as chips, what is coming up, one line per topic.
  await expect(strip.locator(".st-lead")).not.toBeEmpty();
  await expect(strip.locator(".st-chips [data-macro]")).toHaveCount(5);
  await expect(strip.locator(".st-ahead h4")).toHaveText(/Nadchodzi/i);
  await expect(strip.locator(".st-trow", { hasText: /Waluty|Bez tematu|Bez segmentu/ })).toHaveCount(0);
  await expect(strip.locator(".st-trow").first()).toBeVisible();
  // Kandydaci live in the home rail, under Alerty.
  const rail = page.locator(".split .rail");
  await expect(rail.locator("#inv-candidates")).toBeVisible();
  const ids = await rail.locator(".w[id]").evaluateAll((els) => els.map((e) => e.id));
  expect(ids.indexOf("inv-candidates")).toBeGreaterThan(ids.indexOf("inv-alerts"));
  // A topic line opens in place; "Cały temat" opens the topic drawer over the home (no research page).
  await strip.locator('.st-trow[data-topic="bonds"]').click();
  await strip.getByRole("button", { name: "Cały temat →" }).click();
  await expect(page).toHaveURL(/investments\.portfolio\/topics\/bonds$/);
  const drawer = page.getByRole("dialog", { name: "Obligacje i stopy" });
  await expect(drawer.locator("#topic-thesis")).toBeVisible();
  await expect(drawer.locator("#topic-notes article[data-note]", { hasText: "Rynek oczekuje stabilnych stóp procentowych" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  await expect(page).toHaveURL(/investments\.portfolio$/);
});
