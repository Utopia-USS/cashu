// Asset detail v3 (design/v3/asset-detail/asset-detail.md 12, owner QA round 3 Q21-Q26): the drawer's header
// with the lots behind `n loty`, one decision per position in a dialog (save, the timeline's Decyzja row, one
// Cofnij), the research rows (expand, sources) and no boundary footer.
import { ANNA, expect, go, test, toasts } from "../fixtures";

const NAME = /^Demo Global Equity/;
const NOTE = "GLBA: napływy do funduszu rosną";

test("asset detail: header lots, research rows, no boundary footer", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  await page.getByRole("region", { name: "Aktywa" }).locator("tr.rowlink", { hasText: "GLBA" }).first().click();
  const drawer = page.getByRole("dialog", { name: NAME });
  await expect(drawer).toBeVisible();

  // header: facts, the meta line, the lot table behind `n loty`
  const head = drawer.locator(".ahead");
  await expect(head.getByText("Wartość", { exact: true })).toBeVisible();
  await expect(head.getByRole("button", { name: "+ Transakcja" })).toBeVisible();
  await expect(head.getByRole("button", { name: "Zanotuj decyzję" })).toBeVisible();
  const lots = head.locator(".hmeta").getByText(/^\d+ lot/);
  await expect(lots).toBeVisible();
  if (await head.locator(".hmeta").getByRole("button", { name: /^\d+ lot/ }).count()) {
    const toggle = head.locator(".hmeta").getByRole("button", { name: /^\d+ lot/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(head.locator(".hlots table tbody tr").first()).toBeVisible();
    await toggle.click();
    await expect(head.locator(".hlots")).toHaveCount(0);
  }
  await expect(head.locator(".hmeta").getByRole("button", { name: /^\d+ transakcj/ })).toBeVisible();

  // Q24: no boundary footer anywhere in the detail (checked before a note's own summary is expanded)
  await expect(drawer.getByText(/bez rekomendacji/)).toHaveCount(0);
  // Q26: no per-row decision buttons in Sygnały i decyzje
  const signals = drawer.getByRole("region", { name: "Sygnały i decyzje" });
  await expect(signals.getByRole("button", { name: "Zanotuj decyzję" })).toHaveCount(0);

  // Q22: a note row expands to its summary, `źródła (n)` lists the sources
  const row = drawer.locator("article.nr", { hasText: NOTE });
  await expect(row).toBeVisible();
  await expect(row.locator(".ri")).toHaveAttribute("aria-label", "wzmacnia tezę");
  await row.locator("button.nrh").click();
  await expect(row.locator(".nx")).toBeVisible();
  await row.getByRole("button", { name: /^źródła \(\d+\)$/ }).click();
  await expect(row.locator("ul.nsrc li").first()).toBeVisible();
});

const openGlba = async (page: import("@playwright/test").Page) => {
  await go(page, `${ANNA}/investments.portfolio`);
  await page.getByRole("region", { name: "Aktywa" }).locator("tr.rowlink", { hasText: "GLBA" }).first().click();
  const drawer = page.getByRole("dialog", { name: NAME });
  await expect(drawer).toBeVisible();
  return drawer;
};

test("asset detail: potwierdź on an open row and its Cofnij", async ({ app: page }) => {
  const drawer = await openGlba(page);
  const signals = drawer.getByRole("region", { name: "Sygnały i decyzje" });
  const rows = signals.locator(".sig.orow");
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  await rows.first().hover();
  await rows.first().getByRole("button", { name: "potwierdź" }).click();
  const toast = toasts(page).locator(".toast", { hasText: "Potwierdzone bez zmian" });
  await expect(toast).toBeVisible();
  await expect(rows).toHaveCount(n - 1);
  await expect(signals.locator(".tl .t", { hasText: /^Potwierdzone/ }).first()).toBeVisible();
  await toast.getByRole("button", { name: "Cofnij" }).click();
  await expect(toasts(page)).toContainText("Cofnięto");
  await expect(rows).toHaveCount(n);
});

test("asset detail: one decision per position, the timeline row and one Cofnij", async ({ app: page }) => {
  const drawer = await openGlba(page);
  const head = drawer.locator(".ahead");
  const decide = head.getByRole("button", { name: "Zanotuj decyzję" });
  const signals = drawer.getByRole("region", { name: "Sygnały i decyzje" });
  const rows = signals.locator(".sig.orow");
  await expect(rows.first()).toBeVisible();
  const n = await rows.count();
  await expect(head.locator(".hsig")).toBeVisible();

  await decide.click();
  const dialog = page.getByRole("dialog", { name: /^Decyzja · / });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("otwarte sygnały", { exact: true })).toBeVisible();
  await expect(dialog.locator(".dctx .ln")).toHaveCount(Math.min(n, 5));
  await expect(dialog.getByRole("button", { name: "Potwierdź" })).toHaveCount(0);
  // Esc from inside the form closes the dialog only; the drawer stays and focus returns to the button
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(drawer).toBeVisible();
  await expect(decide).toBeFocused();
  // the same from the dialog's ✕
  await decide.click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Zamknij" }).focus();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(drawer).toBeVisible();
  await expect(decide).toBeFocused();

  await decide.click();
  await expect(dialog).toBeVisible();
  const reason = "e2e: jedna decyzja na pozycję";
  await dialog.getByRole("button", { name: "Nic", exact: true }).click();
  await dialog.getByPlaceholder("Dlaczego?").fill(reason);
  await dialog.getByRole("button", { name: "Zapisz decyzję" }).click();
  const toast = toasts(page).locator(".toast", { hasText: "Zapisano decyzję" });
  await expect(toast).toBeVisible();
  await expect(dialog).toBeHidden();

  // one Decyzja row, every open row covered, no state glyph left in the header
  const decided = signals.locator(".tl .t", { hasText: reason });
  await expect(decided).toBeVisible();
  await expect(decided).toContainText("Decyzja · bez zmian");
  await expect(rows).toHaveCount(0);
  await expect(head.locator(".hsig")).toHaveCount(0);

  // one Cofnij restores every row
  await toast.getByRole("button", { name: "Cofnij" }).click();
  await expect(toasts(page)).toContainText("Cofnięto");
  await expect(decided).toHaveCount(0);
  await expect(rows).toHaveCount(n);
  await expect(head.locator(".hsig")).toBeVisible();
});

test("asset detail: ?note= opens and highlights its row", async ({ app: page }) => {
  const drawer = await openGlba(page);
  const row = drawer.locator("article.nr", { hasText: NOTE });
  await expect(row).toBeVisible();
  const noteId = await row.getAttribute("data-note");
  const id = /assets\/(\d+)/.exec(page.url())?.[1];
  expect(noteId && id).toBeTruthy();
  await page.keyboard.press("Escape");
  await go(page, `${ANNA}/investments.portfolio/assets/${id}?note=${noteId}`);
  const target = page.getByRole("dialog", { name: NAME }).locator(`article.nr[data-note="${noteId}"]`);
  await expect(target).toHaveClass(/\bhl\b/);
  await expect(target.locator(".nx")).toBeVisible();
  await expect(target.locator("button.nrh")).toHaveAttribute("aria-expanded", "true");
});

// The demo seed has no signal on a watched instrument, so the watched case covers the layout only.
test("asset detail: a watched instrument has no facts and no decision without a signal", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const assets = page.getByRole("region", { name: "Aktywa" });
  await assets.getByRole("button", { name: /^Obserwowane \d+$/ }).click();
  await assets.locator("tr.rowlink", { hasText: "Demo Wodociągi SA" }).first().click();
  const drawer = page.getByRole("dialog", { name: /Demo Wodociągi/ });
  await expect(drawer).toBeVisible();
  const head = drawer.locator(".ahead");
  await expect(head).toContainText("obserwowany");
  await expect(head.locator(".hfx")).toHaveCount(0);
  await expect(head.locator(".hmeta")).toHaveCount(0);
  await expect(head.getByRole("button", { name: "+ Transakcja" })).toHaveCount(0);
  const decide = head.getByRole("button", { name: "Zanotuj decyzję" });
  await expect(decide).toBeDisabled();
  await expect(decide).toHaveAttribute("title", "Brak otwartego sygnału");
  await expect(drawer.getByRole("region", { name: "Sygnały i decyzje" })).toBeVisible();
  await expect(drawer.getByRole("region", { name: "Alerty" })).toBeVisible();
});
