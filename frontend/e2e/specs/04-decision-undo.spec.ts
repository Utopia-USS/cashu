// A decision on a signal, then undo: once with the row's "cofnij" link (browser in Europe/Warsaw, F7 FE1:
// the server's UTC timestamps keep the 15-minute window open) and once with the toast's "Cofnij". The flow
// runs in the signals dialog (`Wszystkie (n)` in the rail): the rail's compact rows drop a decided signal,
// the dialog keeps it quiet at the bottom with its "cofnij" link (signals-rail.md 2-3).
import type { Locator, Page } from "@playwright/test";
import { ANNA, expect, go, test, toasts } from "../fixtures";

async function decideOnFirstSignal(page: Page, reason: string): Promise<Locator> {
  await go(page, `${ANNA}/investments.portfolio`);
  await page.getByRole("region", { name: "Sygnały" }).getByRole("button", { name: /^Wszystkie \(\d+\)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Sygnały" });
  const first = dialog.locator("[data-signal]", { has: page.getByRole("button", { name: "Zanotuj decyzję" }) }).first();
  const id = await first.getAttribute("data-signal");
  const row = dialog.locator(`[data-signal="${id}"]`);
  await row.getByRole("button", { name: "Zanotuj decyzję" }).click();
  await row.getByLabel("Powód decyzji").fill(reason);
  await row.getByRole("button", { name: "Zapisz decyzję" }).click();
  await expect(toasts(page)).toContainText("Zapisano decyzję");
  await expect(row.getByRole("button", { name: "Zanotuj decyzję" })).toBeHidden();
  return row;
}

test("decision undone with the row link (Europe/Warsaw)", async ({ app: page }) => {
  expect(await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone)).toBe("Europe/Warsaw");
  const row = await decideOnFirstSignal(page, "E2E: bez zmian");
  const undo = row.getByRole("button", { name: "cofnij", exact: true });
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(toasts(page)).toContainText("Cofnięto: decyzja");
  await expect(row.getByRole("button", { name: "Zanotuj decyzję" })).toBeVisible();
});

test("decision undone with the toast", async ({ app: page }) => {
  const row = await decideOnFirstSignal(page, "E2E: toast");
  await toasts(page).locator(".toast", { hasText: "Zapisano decyzję" }).getByRole("button", { name: "Cofnij" }).click();
  await expect(toasts(page)).toContainText("Cofnięto: decyzja");
  await expect(row.getByRole("button", { name: "Zanotuj decyzję" })).toBeVisible();
});

test("signals dialog: one Zanotuj decyzję and one Potwierdź per multi-signal subject, Potwierdź covers the group", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  await page.getByRole("region", { name: "Sygnały" }).getByRole("button", { name: /^Wszystkie \(\d+\)$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Sygnały" });
  // no sub-row carries its own decision buttons (owner: per group, not per signal)
  await expect(dialog.locator(".sub-sig").getByRole("button", { name: "Zanotuj decyzję" })).toHaveCount(0);
  await expect(dialog.locator(".sub-sig").getByRole("button", { name: "Potwierdź" })).toHaveCount(0);
  const group = dialog.locator(".sig.grp:not(.quiet)").first();
  test.skip(!(await group.count()), "no multi-signal subject in the demo data");
  const key = await group.getAttribute("data-group");
  const g = dialog.locator(`.sig.grp[data-group="${key}"]`);
  const live = await g.locator(".sub-sig:not(.quiet)").count();
  await expect(g.locator(".gact").getByRole("button", { name: "Zanotuj decyzję" })).toHaveCount(1);
  await expect(g.locator(".gact").getByRole("button", { name: "Potwierdź" })).toHaveCount(1);
  // Zanotuj decyzję opens the position's decision dialog with every open signal of the group
  if (key?.startsWith("i:")) {
    await g.locator(".gact").getByRole("button", { name: "Zanotuj decyzję" }).click();
    const decide = page.getByRole("dialog", { name: /^Decyzja · / });
    await expect(decide).toBeVisible();
    await expect(decide.locator(".dctx .ln")).toHaveCount(Math.min(live, 5));
    await page.keyboard.press("Escape");
    await expect(decide).toBeHidden();
    await expect(dialog).toBeVisible();
  }
  await g.locator(".gact").getByRole("button", { name: "Potwierdź" }).click();
  const toast = toasts(page).locator(".toast", { hasText: "Potwierdzone bez zmian" });
  await expect(toast).toBeVisible();
  await expect(g.locator(".sub-sig:not(.quiet)")).toHaveCount(0);
  await toast.getByRole("button", { name: "Cofnij" }).click();
  await expect(toasts(page)).toContainText("Cofnięto");
  await expect(dialog.locator(`.sig.grp[data-group="${key}"] .sub-sig:not(.quiet)`)).toHaveCount(live);
});
