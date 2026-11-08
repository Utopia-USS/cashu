import {
  currentVault,
  expect,
  openProfileMenuItem,
  pickLanguage,
  pickProfile,
  rewriteHash,
  test,
} from "../electron-test.ts";
import { readHostQuery } from "../host-query.ts";
import { openNativeDemo } from "../native-baseline.ts";

type Profile = { name: string; baseCurrency: string; mcpPrivacy: "strict" | "amounts" };
type Proposal = { gid: string; kind: string; status: string };

test("Settings saves the profile and agent privacy in one vault, reviews the agent's proposals and pins the language", async () => {
  const demo = await openNativeDemo({ env: { CASHU_E2E_SETTINGS: "1" } });
  const { page, dataDir } = demo;
  try {
    await pickProfile(page, "Demo Piotr");
    const piotr = currentVault(page);
    await pickProfile(page, "Demo Anna");
    const anna = currentVault(page);
    if (anna === piotr) throw new Error("synthetic vault pair absent");
    const profileOf = (vault: string) => readHostQuery<Profile>(dataDir, vault, "core.profile");
    const proposalsOf = (vault: string, status: "pending" | "rejected") =>
      readHostQuery<Proposal[]>(dataDir, vault, "core.desktopProposals.list", {
        status,
        privacy: true,
      });
    const original = await profileOf(anna);
    const other = await profileOf(piotr);

    // Ustawienia sits in the profile menu.
    await openProfileMenuItem(page, "Ustawienia");
    const profile = page.getByRole("region", { name: "Profil", exact: true });
    await profile
      .getByRole("textbox", { name: "Nazwa", exact: true })
      .fill("Synthetic Settings102");
    await profile.getByRole("combobox", { name: "Waluta bazowa" }).selectOption("EUR");
    await profile.getByRole("button", { name: "Zapisz", exact: true }).click();
    await expect
      .poll(() => profileOf(anna))
      .toMatchObject({ name: "Synthetic Settings102", baseCurrency: "EUR" });
    expect(await profileOf(piotr)).toMatchObject(other);
    await pickProfile(page, "Demo Piotr");
    await rewriteHash(page, /\/overview(?=\?|$)/u, "/settings");
    await expect(profile.getByRole("textbox", { name: "Nazwa" })).toHaveValue(other.name);
    await pickProfile(page, "Synthetic Settings102");
    await rewriteHash(page, /\/overview(?=\?|$)/u, "/settings");

    // The agent's (MCP) privacy level is stored for this profile only.
    const agent = page.getByRole("region", { name: "Agent AI (MCP)" });
    const nextPrivacy = original.mcpPrivacy === "strict" ? "amounts" : "strict";
    await agent
      .locator(`input[name="mcp-privacy"]`)
      .nth(nextPrivacy === "strict" ? 0 : 1)
      .click();
    await expect.poll(async () => (await profileOf(anna)).mcpPrivacy).toBe(nextPrivacy);
    expect((await profileOf(piotr)).mcpPrivacy).toBe(other.mcpPrivacy);

    // Proposals belong to their vault; a rejection is stored and leaves the list.
    expect(await proposalsOf(piotr, "pending")).toEqual([]);
    const pending = await proposalsOf(anna, "pending");
    expect(pending.map((row) => row.kind)).toEqual(
      expect.arrayContaining(["budget_import", "custom_rule", "import", "strategy"]),
    );
    const strategyGid = pending.find((row) => row.kind === "strategy")?.gid;
    const proposals = agent.getByRole("region", { name: "Propozycje agenta" });
    const drawer = page.getByRole("dialog", { name: "Propozycja agenta" });
    const strategyOpener = proposals
      .getByRole("button", { name: "Otwórz propozycję" })
      .filter({ hasText: "Nowa strategia: 2 reguły, 1 koszyk" });
    await strategyOpener.click();
    await expect(drawer).toContainText("Zmiana w strategy.yaml");
    await drawer.getByRole("button", { name: "Odrzuć" }).click();
    await expect(drawer).toHaveCount(0);
    await expect
      .poll(() => proposalsOf(anna, "rejected"))
      .toContainEqual(expect.objectContaining({ gid: strategyGid, status: "rejected" }));
    await expect(strategyOpener).toHaveCount(0);

    // Privacy mode drops the proposal values and keeps the drawer closed.
    const incognito = page.getByRole("checkbox", { name: "Ukryj kwoty", exact: true });
    await incognito.click();
    await expect(proposals).not.toContainText("Nowa reguła: w teście wstecznym 1 epizod");
    await proposals.getByRole("button", { name: "Otwórz propozycję" }).first().click();
    await expect(drawer).toHaveCount(0);
    await incognito.click();
    await expect(proposals).toContainText("Nowa reguła: w teście wstecznym 1 epizod");

    // The language pin survives a reload.
    await pickLanguage(page, "English");
    await page.reload();
    await expect(
      page
        .getByRole("group", { name: "Language", exact: true })
        .getByRole("button", { name: "English", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await pickLanguage(page, "Polski");
  } finally {
    await demo.close();
  }
});
