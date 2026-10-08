// Q27: the asset detail of a watched (not held) instrument shows why it is watched (the watchlist note, edited
// in place) and its thesis with Dodaj / Edytuj, like a held position.
import { ANNA, expect, go, test, toasts } from "../fixtures";

const NOTE = "Stabilna spółka infrastrukturalna, do obserwacji.";

test("watched asset: Dlaczego obserwuję and Teza", async ({ app: page }) => {
  await go(page, `${ANNA}/investments.portfolio`);
  const assets = page.getByRole("region", { name: "Aktywa" });
  await assets.getByRole("button", { name: /^Obserwowane \d+$/ }).click();
  await assets.locator("tr.rowlink", { hasText: "Demo Wodociągi SA" }).first().click();
  const drawer = page.getByRole("dialog", { name: /Demo Wodociągi/ });
  await expect(drawer).toBeVisible();

  // the watchlist note in full, edited in place; Esc cancels the edit and keeps the drawer
  const why = drawer.getByRole("region", { name: "Dlaczego obserwuję" });
  await expect(why).toContainText(NOTE);
  await why.getByRole("button", { name: "Edytuj" }).click();
  const box = why.getByRole("textbox", { name: "Dlaczego obserwuję" });
  await expect(box).toHaveValue(NOTE);
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(drawer).toBeVisible();
  const reason = "e2e: korekta i wysoka dywidenda, czekam na stabilizację kursu po wynikach kwartalnych";
  await why.getByRole("button", { name: "Edytuj" }).click();
  await box.fill(reason);
  await why.getByRole("button", { name: "Zapisz" }).click();
  await expect(toasts(page)).toContainText("Zapisano");
  await expect(why).toContainText(reason);
  await expect(box).toHaveCount(0);

  // no thesis yet: Dodaj opens the thesis drawer for this instrument
  const thesis = drawer.getByRole("region", { name: "Teza" });
  await expect(thesis).toContainText("Brak tezy.");
  await thesis.getByRole("button", { name: "Dodaj" }).click();
  const field = (label: string) => thesis.locator("p").filter({ has: page.getByText(label, { exact: true }) });
  const form = page.getByRole("dialog", { name: "Teza" });
  await expect(form).toBeVisible();
  await form.getByLabel("Wejście", { exact: true }).fill("e2e: wejście po korekcie");
  await form.getByLabel("Unieważnienie", { exact: true }).fill("e2e: cięcie dywidendy");
  await form.getByLabel("Plan wyjścia", { exact: true }).fill("e2e: powrót do szczytu");
  await form.getByLabel("Wielkość i dokupienia", { exact: true }).fill("e2e: 2 % portfela");
  await form.getByRole("button", { name: "Zapisz" }).click();
  await expect(toasts(page)).toContainText("Zapisano tezę");
  await expect(form).toBeHidden();
  for (const [label, text] of [["Wejście", "wejście po korekcie"], ["Unieważnienie", "cięcie dywidendy"],
    ["Plan wyjścia", "powrót do szczytu"], ["Wielkość i dokupienia", "2 % portfela"]]) {
    await expect(field(label)).toContainText(text);
  }

  // Edytuj changes the same thesis
  await thesis.getByRole("button", { name: "Edytuj" }).click();
  await expect(form.getByLabel("Wejście", { exact: true })).toHaveValue("e2e: wejście po korekcie");
  await form.getByLabel("Plan wyjścia", { exact: true }).fill("e2e: nowy plan wyjścia");
  await form.getByRole("button", { name: "Zapisz" }).click();
  await expect(form).toBeHidden();
  await expect(field("Plan wyjścia")).toContainText("nowy plan wyjścia");
  await expect(field("Wejście")).toContainText("wejście po korekcie");
});
