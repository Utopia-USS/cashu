// P7 "Tematy": the research page widget (renamed from Rynek) lists held topics, then watched-only topics (muted,
// trend only), with the currency effect as a muted footer line and no unassigned row or line anywhere (owner P7);
// the home Tematy column shows the watched-only topic after the held ones without a contribution.
// Demo Anna holds GLBA (Akcje globalne), BNDA (Obligacje i stopy), DMEN (Ropa i gaz) and watches DMSE
// (AI: chipy i centra danych) and DMWA (no topic).
import { ANNA, expect, go, test } from "../fixtures";

test("topics: the research page widget, a watched-only topic, the currency footer, no unassigned", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio/research`);
  await expect(page.getByRole("button", { name: /^Tematy · 3$/ })).toBeVisible();
  const widget = page.locator("#rsch-segments");
  await expect(widget.locator(".wh")).toContainText("Tematy");
  const wo = widget.locator(".sgrow.wo", { hasText: "AI: chipy i centra danych" });
  await expect(wo).toBeVisible();
  await expect(wo.locator(".num").first()).toHaveText("-");
  await expect(wo.locator(".num").nth(1)).toHaveText(/^[+-]?\d+,\d\s%$/);
  await expect(wo.locator(".chips")).toContainText("DMSE");
  await expect(widget.locator(".sgfoot")).toContainText("waluty");
  await expect(page.getByText(/bez tematu|bez segmentu/i)).toHaveCount(0);
  // An unknown or unassigned key opens the page unfiltered (no chip).
  await go(page, `${ANNA}/investments.portfolio/research?segment=unassigned`);
  await expect(page.locator("#rsch-notes article[data-note]").first()).toBeVisible();
  await expect(page.locator("#rsch-notes").getByRole("button", { name: /✕$/ })).toHaveCount(0);
});

test("topics: the home column shows the watched-only topic after the held ones, without contribution", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const col = page.locator("#inv-research .tcol");
  const rows = col.locator(".trow");
  await expect(rows.first()).toBeVisible();
  const wo = col.locator(".trow.wo", { hasText: "AI: chipy i centra danych" });
  await expect(wo).toBeVisible();
  await expect(wo.locator(".pp")).toHaveCount(0);
  await expect(wo.locator(".sym")).toContainText("DMSE");
  const kinds = await rows.evaluateAll((els) => els.map((e) => e.classList.contains("wo")));
  expect(kinds.indexOf(true)).toBeGreaterThan(0);
  expect(kinds.slice(kinds.indexOf(true)).every(Boolean)).toBe(true);
  await expect(col.getByRole("button", { name: /^pozostałe/ })).toHaveCount(0);
});
