// P7 / P9 "Tematy" on the home: topics with the newest research / thesis activity first, then held before watched-only
// (muted, no contribution); P11 the market view under the thesis; every topic expanded
// (no `pozostałe N`), the tickers as a subtitle, no trend numbers, the research briefs under the topic; the name
// opens the topic drawer (thesis, notes, members). The research page has no Tematy widget or scope any more.
// Demo Anna holds GLBA (Akcje globalne), BNDA (Obligacje i stopy), DMEN (Ropa i gaz) and watches DMSE
// (AI: chipy i centra danych) and DMWA (no topic).
import { ANNA, expect, go, test, toasts } from "../fixtures";

test("topics: the home column, latest activity first, briefs, no trend numbers", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const col = page.locator("#inv-research .tcol");
  const rows = col.locator(".trow");
  await expect(rows.first()).toBeVisible();
  const wo = col.locator(".trow.wo", { hasText: "AI: chipy i centra danych" });
  await expect(wo).toBeVisible();
  await expect(wo.locator(".pp")).toHaveCount(0);
  await expect(wo.locator(".sym")).toContainText("DMSE");
  // the newest research / thesis activity first (the owner's lasting rule): the demo's thesis and market view on
  // the watched-only AI topic are written last, so it leads; held rows follow it
  await expect(rows.first()).toHaveAttribute("data-topic", "semis_ai");
  await expect(col.locator(".trow:not(.wo)").first()).toBeVisible();
  await expect(col.getByRole("button", { name: /^pozostałe/ })).toHaveCount(0);
  // P9: no trend column and no `4 tyg.` anywhere in the rows; held rows keep the pp contribution
  await expect(rows.locator(".tr")).toHaveCount(0);
  await expect(col).not.toContainText("4 tyg.");
  await expect(col.locator(".trow:not(.wo) .pp").first()).toHaveText(/pp$/);
  // the demo's topic briefs: a headline line (with a date) under its topic
  await expect(col.locator(".trow .tb li .bh").first()).not.toBeEmpty();
  await expect(page.getByText(/bez tematu|bez segmentu/i)).toHaveCount(0);
});

test("topics: the name opens the drawer with the thesis, the notes and the members", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const col = page.locator("#inv-research .tcol");
  const row = col.locator(".trow", { has: page.locator(".tb li") }).first();
  const name = (await row.locator("button.nm").innerText()).trim();
  await row.locator("button.nm").click();
  await expect(page).toHaveURL(/investments\.portfolio\/topics\/[a-z_]+$/);
  const drawer = page.getByRole("dialog", { name });
  await expect(drawer.locator("#topic-thesis")).toBeVisible();
  await expect(drawer.locator("#topic-notes article[data-note]").first()).toBeVisible();
  await expect(drawer.locator("#topic-members [data-member]").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  // the research page lost its Tematy widget and scope; an unknown key opens it unfiltered
  await go(page, `${ANNA}/investments.portfolio/research?segment=unassigned`);
  await expect(page.locator("#rsch-notes article[data-note]").first()).toBeVisible();
  await expect(page.locator("#rsch-segments")).toHaveCount(0);
  await expect(page.locator("#rsch-notes").getByRole("button", { name: /✕$/ })).toHaveCount(0);
});

test("topics: the market view sits under the thesis on the home row and in the drawer, the owner edits it", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const row = page.locator("#inv-research .tcol .trow", { hasText: "AI: chipy i centra danych" });
  const line = row.locator(".tv");
  await expect(line).toContainText("Ocena teraz");
  await expect(line).toContainText("Perspektywa");
  await expect(line).toContainText("szacuje wzrost sprzedaży chipów do AI");
  // the outlook's tooltip names the publishers of the cited estimates
  await expect(line.locator("div", { hasText: "Perspektywa" })).toHaveAttribute("title", /Źródła: Example Industry Association/);
  await row.locator("button.nm").click();
  await expect(page).toHaveURL(/investments\.portfolio\/topics\/semis_ai$/);
  const thesis = page.getByRole("dialog", { name: "AI: chipy i centra danych" }).locator("#topic-thesis");
  const view = thesis.locator(".tview");
  await expect(view).toContainText("Ocena teraz");
  await expect(view).toContainText("Popyt na chipy do AI jest bardzo silny");
  await expect(view).toContainText("szacuje wzrost sprzedaży chipów do AI o ok. 15 %");
  // the cited sources under the view: small links `publisher · d.mm.yyyy`
  const src = view.locator(".vsrc a");
  await expect(src).toHaveCount(1);
  await expect(src).toHaveText(/^Example Industry Association · \d{1,2}\.\d{2}\.\d{4}$/);
  await expect(src).toHaveAttribute("href", "https://example.org/demo/semis-estimate");
  // the owner edits only the outlook: the thesis stays, the view is saved and shown
  await thesis.getByRole("button", { name: "Edytuj" }).click();
  await thesis.getByLabel("Perspektywa").fill("W horyzoncie 2 lat popyt na chipy do AI zwolni, gdy centra danych nadrobią moce.");
  await thesis.getByRole("button", { name: "Zapisz" }).click();
  await expect(toasts(page)).toContainText("Zapisano ocenę");
  await expect(view).toContainText("W horyzoncie 2 lat popyt na chipy do AI zwolni");
  await expect(view.locator(".vsrc a")).toHaveCount(1); // the owner's edit keeps the cited sources
  await expect(thesis).toContainText("Centra danych dla AI potrzebują coraz więcej chipów");
  // a price call is refused with the reason, nothing changes
  await thesis.getByRole("button", { name: "Edytuj" }).click();
  await thesis.getByLabel("Perspektywa").fill("Kurs akcji producentów wzrośnie o połowę w ciągu roku.");
  await thesis.getByRole("button", { name: "Zapisz" }).click();
  await expect(thesis.locator(".neg")).toContainText("Nie udało się zapisać");
  await thesis.getByRole("button", { name: "Anuluj" }).click();
  await expect(view).toContainText("W horyzoncie 2 lat popyt na chipy do AI zwolni");
});
