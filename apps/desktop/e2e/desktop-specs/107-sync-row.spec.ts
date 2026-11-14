// Settings > Devices on a native host without a sync config (the synthetic demo has none): the Sync
// row is hidden entirely, the pairing card carries the relay-era intro (#23.7) and nothing on the card
// speaks of a shared network or names the relay.
import { expect, openProfileMenuItem, test } from "../electron-test.ts";
import { openNativeDemo } from "../native-baseline.ts";

test("Devices hides the Sync row without a sync config and pairs without same-network copy", async () => {
  const demo = await openNativeDemo();
  const { page } = demo;
  try {
    await openProfileMenuItem(page, "Ustawienia");
    const devices = page.locator("#devices");
    await expect(devices).toContainText(
      "Otwórz cashU na telefonie i zeskanuj ten kod. Telefon potrzebuje internetu; Mac nie musi być włączony.",
    );
    await expect(devices.getByRole("heading", { name: "Synchronizacja", exact: true })).toHaveCount(
      0,
    );
    await expect(devices.getByRole("switch", { name: "Synchronizacja" })).toHaveCount(0);
    const text = ((await devices.textContent()) ?? "").toLowerCase();
    for (const word of ["tej samej sieci", "same network", "relay", "przekaźnik"])
      expect(text).not.toContain(word);
  } finally {
    await demo.close();
  }
});
