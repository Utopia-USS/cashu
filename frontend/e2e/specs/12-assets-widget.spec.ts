// Majątek lives on Przegląd (F7 merge): the module's widget lists the demo flat and car, `+ Dodaj` adds a
// position through the drawer (net worth follows), a row opens it for a note, `Usuń` removes it and the toast's
// `Cofnij` brings it back; the old tab route lands on Przegląd with the widget ringed and the URL normalised.
import type { Page } from "@playwright/test";
import { ANNA, expect, go, plNumber, tab, test, toasts } from "../fixtures";

const NAME = "Kaucja za najem";
const NOTE = "zwrot po wyprowadzce";

const netWorth = async (page: Page) =>
  plNumber(await page.getByRole("region", { name: "Wartość netto", exact: true }).locator(".h1 .v").innerText());
/** Net worth change since `before`, rounded to grosze (float noise of the parsed sum). */
const grew = async (page: Page, before: number) => Math.round((await netWorth(page) - before) * 100) / 100;

test("Majątek widget: add, note, remove + Cofnij, old tab route", async ({ app: page }) => {
  await go(page, `${ANNA}/overview`);
  const widget = page.getByRole("region", { name: "Majątek", exact: true });
  await expect(widget).toContainText("Mieszkanie Demo");
  await expect(widget).toContainText("Samochód Demo");
  await expect(widget).toContainText("/ mies.");
  await expect(tab(page, "Majątek")).toHaveCount(0);
  const before = await netWorth(page);

  // add
  await widget.getByRole("button", { name: "+ Dodaj" }).click();
  const drawer = page.getByRole("dialog", { name: "Majątek" });
  await expect(drawer).toContainText("Nowa pozycja");
  await drawer.getByLabel("Nazwa").fill(NAME);
  await drawer.getByLabel("Wartość").fill("6000");
  await drawer.getByRole("button", { name: "Zapisz" }).click();
  await expect(toasts(page)).toContainText("Dodano");
  await expect(drawer).toBeHidden();
  const row = widget.getByRole("button", { name: `Edytuj: ${NAME}` });
  await expect(row).toBeVisible();
  await expect.poll(() => grew(page, before), { timeout: 15_000 }).toBe(6000);

  // edit the note
  await row.click();
  await expect(drawer).toContainText(NAME);
  await drawer.getByLabel("Notatka").fill(NOTE);
  await drawer.getByRole("button", { name: "Zapisz" }).click();
  await expect(toasts(page)).toContainText("Zapisano");
  await expect(widget.locator(`.tag[title="${NOTE}"]`)).toHaveText("notatka");

  // remove, then Cofnij
  await widget.getByRole("button", { name: `Edytuj: ${NAME}` }).click();
  await drawer.getByRole("button", { name: "Usuń" }).click();
  const toast = toasts(page).locator(".toast", { hasText: `Usunięto ${NAME}` });
  await expect(toast).toBeVisible();
  await expect(widget.getByRole("button", { name: `Edytuj: ${NAME}` })).toBeHidden();
  await expect.poll(() => grew(page, before), { timeout: 15_000 }).toBe(0);
  await toast.getByRole("button", { name: "Cofnij" }).click();
  await expect(widget.getByRole("button", { name: `Edytuj: ${NAME}` })).toBeVisible();
  await expect.poll(() => grew(page, before), { timeout: 15_000 }).toBe(6000);

  // the old tab route: Przegląd, the widget in view and ringed, the URL normalised
  await page.evaluate((r) => { location.hash = `#/${r}`; }, `${ANNA}/assets.list`);
  await expect(page).toHaveURL(new RegExp(`#/${ANNA}/overview$`));
  await expect(widget).toBeInViewport();
  await expect(page.locator('[data-slot="assets.list"]')).toHaveClass(/flash/);
  await expect(tab(page, "Przegląd")).toHaveClass(/\bon\b/);
});
