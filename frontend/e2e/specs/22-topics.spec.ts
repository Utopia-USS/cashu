// P7 / P9 topics as a story: on the home one line per topic with something to say this week (mood word + plain
// headline), the pp share of the portfolio's week for held topics and `obserwowany` for watched-only ones, the quiet
// topics named in one line; a click opens Teraz / Perspektywa and the notes, `Cały temat` the drawer (thesis, notes,
// members, the market view the owner edits). The research page's Tematy tab shows the same as cards.
// Demo Anna holds GLBA (Akcje globalne), BNDA (Obligacje i stopy), DMEN (Ropa i gaz) and watches DMSE
// (AI: chipy i centra danych) and DMWA (no topic).
import { ANNA, expect, go, test, toasts } from "../fixtures";

test("topics: one line per topic, mood and headline, pp for held, obserwowany for watched-only", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const strip = page.locator("#inv-research");
  const rows = strip.locator(".st-trow");
  await expect(rows.first()).toBeVisible();
  const ai = strip.locator('.st-trow[data-topic="semis_ai"]');
  await expect(ai.locator(".imp")).toHaveText("obserwowany");
  await expect(ai.locator(".st-mood")).not.toBeEmpty();
  await expect(strip.locator('.st-trow[data-topic="equity_global"] .imp')).toHaveText(/pp$/);
  // no trend numbers in the lines, quiet topics named once
  await expect(strip.locator(".st-topics")).not.toContainText("4 tyg.");
  await expect(strip.locator(".st-foot")).toContainText("Bez nowości");
  await expect(page.getByText(/bez tematu|bez segmentu/i)).toHaveCount(0);
});

test("topics: Cały temat opens the drawer with the thesis, the notes and the members; the research page shows cards", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const strip = page.locator("#inv-research");
  await strip.locator('.st-trow[data-topic="bonds"]').click();
  await strip.getByRole("button", { name: "Cały temat →" }).click();
  await expect(page).toHaveURL(/investments\.portfolio\/topics\/bonds$/);
  const drawer = page.getByRole("dialog", { name: "Obligacje i stopy" });
  await expect(drawer.locator("#topic-thesis")).toBeVisible();
  await expect(drawer.locator("#topic-notes article[data-note]").first()).toBeVisible();
  await expect(drawer.locator("#topic-members [data-member]").first()).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(drawer).toBeHidden();
  // the research page opens on the Tematy tab; an old ?segment= link opens it unfiltered
  await go(page, `${ANNA}/investments.portfolio/research?segment=unassigned`);
  await expect(page.locator(".st-tcard[data-topic]").first()).toBeVisible();
  await expect(page.locator("#rsch-segments")).toHaveCount(0);
});

test("topics: Teraz / Perspektywa under the topic line on the home and the market view in the drawer, the owner edits it", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const strip = page.locator("#inv-research");
  await strip.locator('.st-trow[data-topic="semis_ai"]').click();
  const line = strip.locator(".st-texp .st-nowout");
  await expect(line).toContainText("Teraz");
  await expect(line).toContainText("Perspektywa");
  await expect(line).toContainText("szacuje wzrost sprzedaży chipów do AI");
  await strip.getByRole("button", { name: "Cały temat →" }).click();
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
