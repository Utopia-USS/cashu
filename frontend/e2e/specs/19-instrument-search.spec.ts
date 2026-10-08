// F12 instrument search (Apple Stocks pattern) against the offline server's fixture search (`VWCE`, `orlen`,
// `nvidia`; anything else finds nothing): `+ Dodaj` on Obserwowane opens one field, a pick adds the listing, the
// row then shows the check; removing keeps the entry (search shows `zapisany`, adding it again says
// `Przywrócono`); the keyboard (Up / Down / Enter / Esc); nothing found -> `Brak wyników` + `Dodaj „<text>”`; the
// asset header's watch toggle; Enter right after typing acts on the new text, never on the previous query's rows.
import { ANNA, expect, go, test, toasts } from "../fixtures";
import type { Page } from "@playwright/test";

async function openSearch(page: Page) {
  await go(page, `${ANNA}/investments.portfolio`);
  const assets = page.getByRole("region", { name: "Aktywa" });
  await assets.getByRole("button", { name: /^Obserwowane \d+$/ }).click();
  await assets.getByRole("button", { name: "+ Dodaj" }).click();
  const field = assets.getByRole("combobox", { name: "Szukaj instrumentu" });
  await expect(field).toBeFocused();
  await expect(field).toHaveAttribute("placeholder", "Nazwa, symbol lub ISIN");
  return { assets, field, results: assets.getByRole("listbox", { name: "Wyniki" }) };
}

test("search: pick VWCE on XETRA, the check; remove, search again shows zapisany, adding it restores", async ({ app: page }) => {
  const { assets, field, results } = await openSearch(page);
  await field.fill("VWCE");
  // the option carries the action in its name (its children are presentational)
  const xetra = results.getByRole("option", { name: /^Obserwuj VWCE, Vanguard FTSE All-World.*, XETRA, ETF$/ });
  await expect(xetra).toContainText("Vanguard FTSE All-World");
  await xetra.click();
  await expect(toasts(page)).toContainText(/Obserwujesz Vanguard FTSE All-World/);
  // the field clears and stays open; the list has the new row
  await expect(field).toHaveValue("");
  await expect(field).toBeFocused();
  const row = assets.locator("tr.rowlink", { hasText: "Vanguard FTSE All-World" });
  await expect(row).toBeVisible();

  await field.fill("VWCE");
  await expect(results.getByRole("option", { name: /^Obserwujesz VWCE, / })).toHaveCount(1);
  await field.press("Escape");
  await expect(field).toBeHidden();

  // remove: one entry kept (zapisany), adding it again restores the same row
  await row.getByRole("button", { name: /^Przestań obserwować / }).click();
  await expect(toasts(page)).toContainText(/Usunięto Vanguard FTSE All-World.* z obserwowanych/);
  await expect(row).toHaveCount(0);
  await assets.getByRole("button", { name: "+ Dodaj" }).click();
  await field.fill("VWCE");
  const saved = results.getByRole("option", { name: /^Obserwuj VWCE, .*, zapisany$/ });
  await expect(saved).toHaveCount(1);
  await expect(saved.locator(".tag", { hasText: "zapisany" })).toHaveAttribute("title", "Wróci z researchem i notatkami");
  await saved.click();
  await expect(toasts(page)).toContainText(/Przywrócono Vanguard FTSE All-World/);
  await expect(row).toBeVisible();
});

test("search: keyboard - Down highlights, Enter adds the highlighted row, Esc closes", async ({ app: page }) => {
  const { assets, field, results } = await openSearch(page);
  await field.fill("nvidia");
  const first = results.getByRole("option").first();
  await expect(first).toContainText("NVDA");
  await expect(first).toContainText("NVIDIA Corporation");
  await expect(results).not.toContainText(/futures/i);
  await field.press("ArrowDown");
  const firstId = await first.getAttribute("id");
  await expect(field).toHaveAttribute("aria-activedescendant", firstId!);
  await expect(first).toHaveAttribute("aria-selected", "true");
  await field.press("ArrowDown");
  await expect(field).not.toHaveAttribute("aria-activedescendant", firstId!);
  await field.press("ArrowUp");
  await expect(field).toHaveAttribute("aria-activedescendant", firstId!);
  await field.press("Enter");
  await expect(toasts(page)).toContainText(/Obserwujesz NVIDIA/);
  await expect(assets.locator("tr.rowlink", { hasText: "NVIDIA" })).toBeVisible();
  await expect(field).toBeFocused();
  await field.press("Escape");
  await expect(field).toBeHidden();
  await expect(assets.getByRole("button", { name: "+ Dodaj" })).toHaveAttribute("aria-expanded", "false");
});

test("search: nothing found -> Brak wyników and the free-text row", async ({ app: page }) => {
  const { assets, field, results } = await openSearch(page);
  await field.fill("ZZQX");
  await expect(assets.getByText("Brak wyników")).toBeVisible();
  await expect(results.getByRole("option")).toHaveCount(1);
  await expect(results.getByRole("option")).toContainText("Dodaj „ZZQX”");
  await field.fill("orlen");
  await expect(results.getByRole("option").filter({ hasText: "PKN" }).first()).toContainText("Orlen");
  await expect(assets.getByText("Brak wyników")).toBeHidden();
});

test("asset header: Obserwujesz stops watching with undo, Obserwuj brings the entry back", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const assets = page.getByRole("region", { name: "Aktywa" });
  await assets.getByRole("button", { name: /^Obserwowane \d+$/ }).click();
  await assets.locator("tr.rowlink", { hasText: "Demo Wodociągi SA" }).first().click();
  const drawer = page.getByRole("dialog", { name: /Demo Wodociągi/ });
  const head = drawer.locator(".ahead");
  await head.getByRole("button", { name: "Obserwujesz" }).click();
  await expect(toasts(page)).toContainText(/Usunięto Demo Wodociągi SA z obserwowanych/);
  await head.getByRole("button", { name: "Obserwuj", exact: true }).click();
  await expect(toasts(page)).toContainText(/Przywrócono Demo Wodociągi SA/);
  await expect(head.getByRole("button", { name: "Obserwujesz" })).toBeVisible();
});

test("search: Enter right after typing acts on the new text, not on the previous query's rows", async ({ app: page }) => {
  const { assets, field, results } = await openSearch(page);
  await field.fill("VWCE");
  await expect(results.getByRole("option", { name: /XETRA/ })).toBeVisible();
  // within the debounce window the VWCE rows are still on screen: Enter waits for the orlen answer
  await field.fill("orlen");
  await field.press("Enter");
  await expect(toasts(page)).toContainText(/Obserwujesz Orlen/);
  await expect(toasts(page)).not.toContainText(/Vanguard/);
  await expect(assets.locator("tr.rowlink", { hasText: "Orlen" })).toBeVisible();
});
