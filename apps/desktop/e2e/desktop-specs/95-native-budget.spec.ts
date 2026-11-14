import { expect, test } from "../electron-test.ts";
import { openNativeDemo } from "../native-baseline.ts";

test("the budget screen: a category change, the cushion, subscriptions, old tab links and the statement import drawer", async () => {
  const demo = await openNativeDemo();
  const { page } = demo;
  try {
    const tabs = page.getByRole("navigation", { name: "Moduły" });
    await tabs.getByRole("button", { name: "Budżet", exact: true }).click();
    const budget = page.getByRole("main", { name: "Budżet", exact: true });
    await expect(budget).toBeVisible();
    const period = budget.getByRole("group", { name: "Okres", exact: true });
    await period.getByRole("button", { name: "Wszystko", exact: true }).click();
    await expect(period.getByRole("button", { name: "Wszystko", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // A category row (name, amount, share) opens its transactions; recategorizing one is an owner write
    // confirmed by a toast that offers the merchant's other transactions.
    const spending = budget.getByRole("region", { name: "Wydatki", exact: true });
    await spending.getByRole("button", { name: /%/u }).first().click();
    const category = budget.getByRole("combobox", { name: "Kategoria", exact: true }).first();
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
    // The drill tile's close (the toast region, inside the page, has its own).
    await budget.getByRole("button", { name: "Zamknij", exact: true }).first().click();
    await expect(budget.getByRole("combobox", { name: "Kategoria", exact: true })).toHaveCount(0);

    // Month mode: the "after the month" tile's cushion target is saved and reopens with the saved value.
    await period.getByRole("button", { name: "Miesiąc", exact: true }).click();
    const after = budget.getByRole("region", { name: "Po zamknięciu miesiąca", exact: true });
    await after.getByRole("button", { name: "Ustaw", exact: true }).click();
    const cushionSwitch = after.getByRole("switch", {
      name: "Poduszka przed inwestycjami",
      exact: true,
    });
    if ((await cushionSwitch.getAttribute("aria-checked")) !== "true") await cushionSwitch.click();
    await after
      .getByRole("group", { name: "Cel poduszki", exact: true })
      .getByRole("button", { name: "Kwota", exact: true })
      .click();
    await after.getByRole("textbox", { name: /^Kwota \([A-Z]{3}\)$/u }).fill("1000");
    await after.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(after.getByRole("button", { name: "Zapisz", exact: true })).toHaveCount(0);
    await after.getByRole("button", { name: "Ustaw", exact: true }).click();
    await expect(after.getByRole("textbox", { name: /^Kwota \([A-Z]{3}\)$/u })).toHaveValue(
      /^1000(\.0+)?$/u,
    );
    await after.getByRole("button", { name: "Anuluj", exact: true }).click();

    // Subscriptions live in the rail of the same screen.
    await expect(budget.getByRole("region", { name: "Subskrypcje", exact: true })).toBeVisible();

    // The former Przepływy and Subskrypcje links land on the one screen, keeping the period.
    for (const old of ["flows", "subs"]) {
      await page.evaluate((tab) => {
        location.hash = location.hash.replace(/\/budget\/[a-z]+/u, `/budget/${tab}`);
      }, old);
      await expect(page).toHaveURL(/\/budget\/expenses/u);
      await expect(budget.getByRole("region", { name: "Wydatki", exact: true })).toBeVisible();
      await expect(period.getByRole("button", { name: "Miesiąc", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    }

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
