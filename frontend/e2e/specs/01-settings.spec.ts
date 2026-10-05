// Settings page: every section renders for the demo profile, a profile edit saves and reverts.
import { ANNA, expect, go, test, toasts, tab } from "../fixtures";

test("settings sections and a profile edit", async ({ app: page }) => {
  await go(page, `${ANNA}/overview`);
  await tab(page, "Ustawienia").click();
  const nav = page.getByRole("navigation", { name: "Sekcje ustawień" });
  for (const label of ["Profil", "Moduły", "Agent AI (MCP)", "Dane", "Praca w tle", "Sekrety", "Aplikacja"]) {
    await expect(nav.getByRole("button", { name: label, exact: true })).toBeVisible();
  }
  for (const title of ["Profil", "Moduły", "Agent AI (MCP)", "Dane"]) {
    await expect(page.getByRole("region", { name: title, exact: true })).toBeVisible();
  }
  const profile = page.getByRole("region", { name: "Profil", exact: true });
  const name = profile.getByLabel("Nazwa");
  await expect(name).toHaveValue("Demo Anna");
  await expect(profile.getByText(ANNA, { exact: true })).toBeVisible();

  await name.fill("Demo Anna E2E");
  await profile.getByRole("button", { name: "Zapisz" }).click();
  await expect(toasts(page)).toContainText("Zapisano");
  await expect(page.getByRole("button", { name: /Demo Anna E2E/ })).toBeVisible();
  await name.fill("Demo Anna");
  await profile.getByRole("button", { name: "Zapisz" }).click();
  await expect(page.getByRole("button", { name: "Demo Anna", exact: false }).first()).toBeVisible();
  await expect(profile.getByRole("button", { name: "Zapisz" })).toBeDisabled();
});
