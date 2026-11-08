import { demoExpectations, renderedGrouped } from "../demo-expectations.ts";
import { expect, test } from "../electron-test.ts";
import { openNativeDemo } from "../native-baseline.ts";

test("investments Home shows the stored portfolio value and an owner transaction from the asset drawer", async () => {
  const demo = await openNativeDemo();
  const { page } = demo;
  try {
    const expected = demoExpectations().anna.portfolio;
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Inwestycje", exact: true })
      .click();
    const portfolio = page.getByTestId("native-portfolio");
    const hero = portfolio.getByRole("region", { name: "Wartość portfela", exact: true });
    await expect(hero).toContainText(renderedGrouped(expected.total, expected.currency));
    // Investment imports come from the agent (propose_import, approved by the owner): no manual Import.
    await expect(portfolio.getByRole("button", { name: "Import", exact: true })).toHaveCount(0);

    const asset = portfolio
      .getByRole("region", { name: "Aktywa", exact: true })
      .getByRole("row")
      .filter({ hasText: expected.firstLabel })
      .getByRole("button")
      .first();
    await asset.click();
    const assetDrawer = page.getByRole("dialog").filter({ hasText: expected.firstLabel }).first();
    await expect(page).toHaveURL(/\/assets\//u);
    await assetDrawer.getByRole("button", { name: /^\d+ transakcj/u }).click();
    const txns = page.getByRole("dialog", { name: "Transakcje instrumentu", exact: true });
    await expect(txns.getByRole("row").first()).toBeVisible();
    const rowsBefore = await txns.getByRole("row").count();
    await txns.getByRole("button", { name: "Dodaj transakcję", exact: true }).click();
    const transaction = page.getByRole("dialog", { name: "Dodaj transakcję", exact: true });
    await transaction.getByRole("combobox", { name: "Typ", exact: true }).selectOption("buy");
    await transaction.getByRole("textbox", { name: "Ilość", exact: true }).fill("1,25");
    await transaction.getByRole("textbox", { name: /^Cena \(/u }).fill("10");
    // A foreign-currency instrument in a PLN account asks for the rate.
    const rate = transaction.getByRole("textbox", { name: /^Kurs \(/u });
    if (await rate.count()) await rate.fill("4,25");
    await transaction.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(transaction).toHaveCount(0);
    await assetDrawer.getByRole("button", { name: /^\d+ transakcj/u }).click();
    await expect(txns.getByRole("row")).toHaveCount(rowsBefore + 1);
  } finally {
    await demo.close();
  }
});
