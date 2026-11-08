import { demoExpectations, renderedGrouped } from "../demo-expectations.ts";
import { expect, rewriteHash, settleModalHistory, test } from "../electron-test.ts";
import { openNativeDemo } from "../native-baseline.ts";

test("loans list and schedule, a new loan with its installment phrase, and the assets first step", async () => {
  const demo = await openNativeDemo();
  const { page } = demo;
  try {
    const expected = demoExpectations().anna.loans;
    if (expected.length === 0) throw new Error("synthetic loans expectations have no loans");
    await page
      .getByRole("navigation", { name: "Moduły" })
      .getByRole("button", { name: "Kredyty", exact: true })
      .click();
    const list = page.getByRole("table", { name: "Kredyty", exact: true });
    for (const loan of expected) {
      await expect(list).toContainText(loan.name);
      await expect(list).toContainText(renderedGrouped(loan.monthlyPayment, loan.currency));
    }
    expect(
      await page.getByRole("table", { name: "Harmonogram", exact: true }).getByRole("row").count(),
    ).toBeGreaterThan(50);

    // New loans and installment matching live on the loans first steps.
    await rewriteHash(page, /\/loans\.list(?:\?.*)?$/u, "/setup/loans");
    await page.getByRole("button", { name: "Dodaj kolejny", exact: true }).click();
    const drawer = page.getByRole("dialog", { name: "Dodaj kredyt", exact: true });
    await drawer.getByRole("textbox", { name: "Nazwa", exact: true }).fill("Synthetic UI loan");
    await drawer.getByRole("textbox", { name: "Kwota kredytu", exact: true }).fill("12000");
    await drawer
      .getByRole("textbox", { name: "Oprocentowanie (% rocznie)", exact: true })
      .fill("0");
    await drawer.getByRole("textbox", { name: "Okres", exact: true }).fill("1");
    await drawer.getByRole("button", { name: "Dodaj", exact: true }).click();
    await expect(drawer).toBeHidden();

    const installmentStep = page.getByRole("button", { name: /^(Zmień|Wskaż ratę)$/u });
    const matching = page.getByRole("dialog", { name: "Rozpoznawanie rat", exact: true });
    const loanChoice = matching.getByRole("combobox", { name: "Kredyt", exact: true });
    await installmentStep.click();
    await loanChoice.selectOption({ label: "Synthetic UI loan" });
    await matching.getByRole("textbox", { name: "Fraza", exact: true }).fill("SYNTHETIC REPAYMENT");
    await matching.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect(matching).toBeHidden();
    await installmentStep.click();
    await loanChoice.selectOption({ label: "Synthetic UI loan" });
    await expect(matching.getByRole("textbox", { name: "Fraza", exact: true })).toHaveValue(
      "SYNTHETIC REPAYMENT",
    );
    await matching.getByRole("button", { name: "wyczyść", exact: true }).click();
    await expect(matching).toBeHidden();

    // 12000 at 0 % over a year: 1000 a month, twelve installments in the schedule.
    await settleModalHistory(page);
    await rewriteHash(page, /\/setup\/loans(?:\?.*)?$/u, "/loans.list");
    await expect(list).toContainText(renderedGrouped("1000", "PLN"));
    await list.getByRole("button", { name: "Synthetic UI loan", exact: true }).click();
    await expect(page.getByRole("table", { name: "Harmonogram" }).getByRole("row")).toHaveCount(13);

    // Manually valued assets have no tab: their first step opens the car drawer.
    await rewriteHash(page, /\/loans\.list(?:\?.*)?$/u, "/setup/assets");
    await expect(page.getByTestId("native-assets-start")).toBeVisible();
    await page.getByRole("button", { name: "Dodaj auto", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  } finally {
    await demo.close();
  }
});
