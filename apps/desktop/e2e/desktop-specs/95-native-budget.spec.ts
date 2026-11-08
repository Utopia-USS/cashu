import { expect, test } from "../electron-test.ts";
import { openNativeDemo } from "../native-baseline.ts";

test("the budget tabs: a category change, the month-close cushion and the statement import drawer", async () => {
  const demo = await openNativeDemo();
  const { page } = demo;
  try {
    const tabs = page.getByRole("navigation", { name: "Moduły" });
    await tabs.getByRole("button", { name: "Wydatki", exact: true }).click();
    const expenses = page.getByRole("main", { name: "Wydatki", exact: true });
    await expect(expenses).toBeVisible();
    await expenses.getByRole("button", { name: "Wszystko", exact: true }).click();
    // A legend row (label, amount, share) opens the category's transactions; recategorizing one is
    // an owner write confirmed by a toast.
    await expenses.getByRole("button", { name: /%/u }).first().click();
    const category = expenses.getByRole("combobox", { name: "Kategoria", exact: true }).first();
    await expect(category).toBeVisible();
    await category.selectOption(
      (await category.inputValue()) === "groceries" ? "dining" : "groceries",
    );
    await expect(
      page
        .getByRole("region", { name: "Powiadomienia", exact: true })
        .getByRole("status")
        .filter({ hasText: "Zmieniono:" }),
    ).toBeVisible();
    // The panel's close (the toast region, inside the page, has its own).
    await expenses.getByRole("button", { name: "Zamknij", exact: true }).first().click();

    // Przepływy: the month close card's cushion target is saved and reopens with the saved value.
    await tabs.getByRole("button", { name: "Przepływy", exact: true }).click();
    const close = page
      .getByRole("main", { name: "Przepływy", exact: true })
      .getByRole("region", { name: "Zamknięcie miesiąca", exact: true });
    await close.getByRole("button", { name: "Ustaw", exact: true }).click();
    const cushionSwitch = close.getByRole("switch", {
      name: "Poduszka przed inwestycjami",
      exact: true,
    });
    if ((await cushionSwitch.getAttribute("aria-checked")) !== "true") await cushionSwitch.click();
    await close
      .getByRole("group", { name: "Cel poduszki", exact: true })
      .getByRole("button", { name: "Kwota", exact: true })
      .click();
    await close.getByRole("textbox", { name: /^Kwota \([A-Z]{3}\)$/u }).fill("1000");
    await close.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(close.getByRole("button", { name: "Zapisz", exact: true })).toHaveCount(0);
    await close.getByRole("button", { name: "Ustaw", exact: true }).click();
    await expect(close.getByRole("textbox", { name: /^Kwota \([A-Z]{3}\)$/u })).toHaveValue(
      /^1000(\.0+)?$/u,
    );
    await close.getByRole("button", { name: "Anuluj", exact: true }).click();

    await tabs.getByRole("button", { name: "Subskrypcje", exact: true }).click();
    const subs = page.getByRole("main", { name: "Subskrypcje", exact: true });
    await expect(subs.getByRole("region", { name: "Subskrypcje", exact: true })).toBeVisible();

    // The tab bar's Import opens the statement drawer at its file step.
    await tabs.getByRole("button", { name: "Import", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Import wyciągu", exact: true });
    await expect(drawer.getByRole("button", { name: "Podgląd", exact: true })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
  } finally {
    await demo.close();
  }
});
