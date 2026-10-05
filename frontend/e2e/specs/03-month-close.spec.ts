// Budget month close: the closed month's figures, month navigation, the cushion setting; the overview's
// "Nadwyżka → wpłata" card shows the same amount for investments after the cushion top-up (F7 FE5).
import { ANNA, expect, go, plNumber, test } from "../fixtures";

test("month close figures, navigation and cushion edit", async ({ app: page }) => {
  await go(page, `${ANNA}/overview`);
  const card = page.getByText(/^na inwestycje .+ po poduszce$/);
  await expect(card).toBeVisible();
  const overviewAmount = plNumber((await card.innerText()).replace(/^na inwestycje/, ""));

  await page.getByRole("button", { name: "zamknięcie miesiąca" }).click();
  const close = page.getByRole("region", { name: "Zamknięcie miesiąca" });
  await expect(close).toBeVisible();
  for (const label of ["Przychody", "Wydatki", "Nadwyżka", "Na inwestycje"]) {
    await expect(close.locator(".mc-fig .l", { hasText: label })).toBeVisible();
  }
  const invest = close.locator(".mc-fig", { has: page.locator(".l", { hasText: "Na inwestycje" }) }).locator(".v");
  expect(Math.round(plNumber(await invest.innerText()))).toBe(Math.round(overviewAmount));
  await expect(close.getByText(/po dopłacie do poduszki/)).toBeVisible();

  const label = close.getByRole("button", { name: "Poprzedni miesiąc" }).locator("xpath=following-sibling::span[1]");
  const month = await label.innerText();
  await close.getByRole("button", { name: "Poprzedni miesiąc" }).click();
  await expect(label).not.toHaveText(month);
  await close.getByRole("button", { name: "Następny miesiąc" }).click();
  await expect(label).toHaveText(month);

  await close.getByRole("button", { name: "Ustaw" }).click();
  const months = close.getByLabel("Miesięcy wydatków");
  await expect(months).toHaveValue("3");
  await months.fill("4");
  await close.getByRole("button", { name: "Zapisz" }).click();
  await expect(months).toBeHidden();
  await close.getByRole("button", { name: "Ustaw" }).click();
  await expect(close.getByLabel("Miesięcy wydatków")).toHaveValue("4");
  await close.getByLabel("Miesięcy wydatków").fill("3");
  await close.getByRole("button", { name: "Zapisz" }).click();
  await expect(close.getByLabel("Miesięcy wydatków")).toBeHidden();
});
