// Wizard: a new profile with two modules (and its agent workspace in the suite's temp dir); the app
// switches to it, the modules are on in Settings, the other profiles' data is not there.
import { expect, test, toasts, tab } from "../fixtures";

test("wizard creates a profile with modules", async ({ app: page }) => {
  await page.getByRole("button", { name: /^D?\s*Demo (Anna|Piotr)/ }).first().click();
  await page.getByRole("menu", { name: "Profile" }).getByRole("menuitem", { name: /Nowy profil/ }).click();
  const wizard = page.getByRole("dialog", { name: "Nowy profil" });
  await expect(wizard).toBeVisible();

  await wizard.getByLabel("Nazwa profilu").fill("Demo Kasia");
  await wizard.getByRole("button", { name: "Dalej →" }).click();
  await wizard.getByRole("checkbox", { name: /^Budżet domowy/ }).check();
  await wizard.getByRole("checkbox", { name: /^Inwestycje/ }).check();
  await expect(wizard).toContainText("wybrano 2 moduły");
  await wizard.getByRole("button", { name: "Dalej →" }).click();
  await expect(wizard.getByRole("switch", { name: "Utwórz workspace agenta" })).toBeVisible();
  await expect(wizard.locator(".summary")).toContainText("Budżet domowy, Inwestycje");
  await wizard.getByRole("button", { name: "Utwórz profil" }).click();

  await expect(wizard).toBeHidden({ timeout: 20_000 });
  await expect(toasts(page)).toContainText("Profil: Demo Kasia");
  await expect(page).toHaveURL(/#\/demo-kasia\//);
  await expect(page.getByRole("button", { name: /Demo Kasia/ }).first()).toBeVisible();
  await expect(page.getByText("Mieszkanie Demo", { exact: true })).toHaveCount(0);

  await tab(page, "Ustawienia").click();
  const modules = page.getByRole("region", { name: "Moduły", exact: true });
  await expect(modules.getByRole("switch", { name: "Moduł Budżet domowy" })).toHaveAttribute("aria-checked", "true");
  await expect(modules.getByRole("switch", { name: "Moduł Inwestycje" })).toHaveAttribute("aria-checked", "true");
  await expect(modules.getByRole("switch", { name: "Moduł Kredyty" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("region", { name: "Agent AI (MCP)" }).getByRole("button", { name: "Aktualizuj" })).toBeVisible();
});
