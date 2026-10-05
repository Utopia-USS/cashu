// Settings > Agent AI: the agent workspace panel creates the profile's workspace (in the suite's temp
// FINANSE_WORKSPACES_DIR) and then offers "Aktualizuj" and the Claude Code command.
import { ANNA, expect, go, test, toasts, tab } from "../fixtures";

test("workspace panel creates and updates the workspace", async ({ app: page }) => {
  await go(page, `${ANNA}/overview`);
  await tab(page, "Ustawienia").click();
  await page.getByRole("navigation", { name: "Sekcje ustawień" }).getByRole("button", { name: "Agent AI (MCP)" }).click();
  const agent = page.getByRole("region", { name: "Agent AI (MCP)" });
  await expect(agent.getByText("Workspace agenta", { exact: true })).toBeVisible();
  const folder = agent.locator("code").filter({ hasText: /finanse-e2e-.*workspaces/ }).first();
  await expect(folder).toBeVisible();

  await agent.getByRole("button", { name: "Utwórz" }).click();
  await expect(toasts(page)).toBeVisible();
  const update = agent.getByRole("button", { name: "Aktualizuj" });
  await expect(update).toBeVisible();
  await expect(agent.getByText("Otwórz w Claude Code")).toBeVisible();
  await expect(agent.getByText(/skille: .*\/investments-setup/)).toBeVisible();

  await update.click();
  await expect(update).toBeEnabled();
  await expect(agent.getByRole("button", { name: "Utwórz" })).toBeHidden();
});
