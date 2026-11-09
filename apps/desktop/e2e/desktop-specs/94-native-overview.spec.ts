import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { demoExpectations, negate, plus, rendered } from "../demo-expectations.ts";
import { expect, pickProfile, test } from "../electron-test.ts";
import { nativeDemoPaths, openNativeDemo } from "../native-baseline.ts";

/** A whole amount as the Overview widgets show it (no decimals, grouping always). */
function rendered0(amount: string, currency: string, locale = "pl-PL"): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
    minimumFractionDigits: 0,
    useGrouping: "always",
  } as Intl.NumberFormatOptions).format(Math.round(Number(amount)));
}

test("the Overview shows each profile's stored amounts, hides them in privacy mode and saves an asset edit", async () => {
  const demo = await openNativeDemo();
  const { page } = demo;
  try {
    const expected = demoExpectations();
    await expect(page).toHaveURL(/\/overview/u);
    const worth = page.getByTestId("net-worth");
    const annaWorth = rendered(expected.anna.net, expected.anna.currency);
    await expect(worth).toHaveText(annaWorth);

    const budgetWidget = page.getByRole("region", { name: /^Budżet · /u });
    const budgetText = (await budgetWidget.textContent()) ?? "";
    const chosen = Object.values(expected.anna.months).find((month) =>
      budgetText.includes(rendered0(month.income, month.currency)),
    );
    if (!chosen) throw new Error("native budget month is outside the synthetic expectations");
    for (const amount of [chosen.income, chosen.spending, chosen.surplus])
      await expect(budgetWidget).toContainText(rendered0(amount, chosen.currency));

    const accountsWidget = page.getByRole("region", { name: "Konta", exact: true });
    const listed = expected.anna.accounts.filter(
      (account) =>
        ["checking", "savings", "credit", "investment", "other"].includes(account.type) &&
        !(account.bank === "manual" && account.type === "other") &&
        account.amount !== null &&
        Math.abs(Number(account.amount)) >= 0.005,
    );
    await expect(accountsWidget.locator("tbody tr")).toHaveCount(listed.length);
    for (const account of listed)
      if (account.amount !== null)
        await expect(accountsWidget).toContainText(rendered(account.amount, account.currency));

    const assets = expected.anna.assets;
    const assetsWidget = page.getByRole("region", { name: "Majątek", exact: true });
    await expect(assetsWidget.locator("tbody tr")).toHaveCount(Math.min(assets.length, 5));
    for (const asset of assets.slice(0, 5))
      if (asset.amount !== null)
        await expect(assetsWidget).toContainText(rendered0(asset.amount, asset.currency));
    const loansWidget = page.getByRole("region", { name: "Kredyty", exact: true });
    for (const loan of expected.anna.loans)
      await expect(loansWidget).toContainText(rendered(negate(loan.outstanding), loan.currency));
    // The demo holds EUR with an NBP rate: the hero is the net worth converted to PLN.
    const hero = page.getByRole("region", {
      name: "Wartość netto, przeliczona na PLN",
      exact: true,
    });
    await expect(hero).toContainText(
      rendered0(expected.anna.investments.value, expected.anna.investments.currency),
    );
    const chartControl = page.getByRole("group", { name: /^Wartość netto w czasie/u });
    await chartControl.focus();
    await chartControl.press("End");
    await expect(chartControl.getByRole("status")).toContainText(
      rendered(expected.anna.seriesEnd.value, expected.anna.seriesEnd.currency),
    );

    // Another profile shows its own net worth.
    await pickProfile(page, "Demo Piotr");
    await expect(worth).toHaveText(rendered(expected.piotr.net, expected.piotr.currency));
    expect(expected.piotr.net).not.toBe(expected.anna.net);
    await pickProfile(page, "Demo Anna");
    await expect(worth).toHaveText(annaWorth);

    // Privacy mode: the exact amount is never left readable, not even right after the click.
    const privacy = page.getByRole("checkbox", { name: "Ukryj kwoty" });
    await privacy.click();
    const exposed = await page.evaluate((exact) => {
      const amount = document.querySelector('[data-testid="net-worth"]');
      return (
        amount !== null &&
        (amount.textContent ?? "").includes(exact) &&
        amount.getClientRects().length > 0 &&
        getComputedStyle(amount).visibility === "visible" &&
        amount.closest('[aria-hidden="true"], [inert]') === null
      );
    }, annaWorth);
    expect(exposed).toBe(false);
    await expect(privacy).toBeChecked();
    await expect(worth).not.toContainText(/\d/u);
    await expect(page.getByRole("img", { name: /^Wartość netto w czasie/u })).not.toHaveAttribute(
      "aria-label",
      /\d{3}|\d\s?zł/u,
    );
    await chartControl.focus();
    await chartControl.press("End");
    await expect(chartControl.getByRole("status")).toContainText("•••");
    await privacy.click();
    await expect(worth).toHaveText(annaWorth);

    // An owner edit of a manual asset moves the net worth.
    const editIndex = assets.findIndex(
      (asset) =>
        asset.kind === "manual" &&
        asset.currency === expected.anna.currency &&
        asset.amount !== null,
    );
    const edited = assets[editIndex];
    if (!edited || edited.amount === null)
      throw new Error("synthetic demo lacks an editable base-currency asset");
    await assetsWidget.locator("tbody tr").nth(editIndex).getByRole("button").click();
    const editDialog = page.getByRole("dialog", { name: "Majątek", exact: true });
    await editDialog
      .getByRole("textbox", { name: "Wartość", exact: true })
      .fill(plus(edited.amount, "1"));
    await editDialog.getByRole("button", { name: "Zapisz" }).click();
    await expect(editDialog).toHaveCount(0);
    await expect(assetsWidget).toContainText(rendered0(plus(edited.amount, "1"), edited.currency));
    await expect(worth).toHaveText(rendered(plus(expected.anna.net, "1"), expected.anna.currency));

    // A vault-scoped command cannot reach another profile's vault (CLAUDE.md rule 7).
    const { repo, loader } = nativeDemoPaths();
    const scoped = spawnSync(
      process.execPath,
      [
        "--import",
        loader,
        join(repo, "apps/host/src/testing/seedOverviewDemo.ts"),
        "cross-profile",
      ],
      { env: process.env, encoding: "utf8", timeout: 10_000 },
    );
    expect(scoped.status, scoped.stderr).toBe(0);
    expect(scoped.stdout).toContain("scoped drawer commands: pass");
  } finally {
    await demo.close();
  }
});
