// Settings > Devices on a native host without a sync config (the synthetic demo has none): the Sync
// row is hidden entirely, the page is one device list (designer spec devices-v1: this Mac's row, no
// removal select, the closed security details when the host serves a list), "Pair a phone" is not
// offered (pairing needs sync; designer DV2 item 8), and nothing on the page speaks of a shared network
// or names the relay.
import { expect, openProfileMenuItem, test } from "../electron-test.ts";
import { openNativeDemo } from "../native-baseline.ts";

test("Devices hides the Sync row and pairing without a sync config, lists the devices, no same-network copy", async () => {
  const demo = await openNativeDemo();
  const { page } = demo;
  try {
    await openProfileMenuItem(page, "Ustawienia");
    const devices = page.locator("#set-devices");
    await expect(devices).toContainText("Urządzenia, które mogą otworzyć profil „Demo Anna”.");
    await expect(devices.getByRole("heading", { name: "Synchronizacja", exact: true })).toHaveCount(
      0,
    );
    await expect(devices.getByRole("switch", { name: "Synchronizacja" })).toHaveCount(0);
    // One list (this Mac's row first when the host serves one); removal starts from a row's menu,
    // never from a select, and the engine's old sections are gone.
    await expect(devices.locator("select")).toHaveCount(0);
    for (const gone of ["Pochodzenie urządzeń", "Urządzenie pobierające", "Wybierz urządzenie"])
      await expect(devices).not.toContainText(gone);
    const rows = devices.locator("li[data-device]");
    if ((await rows.count()) > 0) {
      await expect(rows.first()).toContainText("Ten Mac");
      await expect(devices.getByText("Szczegóły bezpieczeństwa")).toBeVisible();
    }
    await expect(devices.getByRole("button", { name: "Połącz telefon" })).toHaveCount(0);
    const text = ((await devices.textContent()) ?? "").toLowerCase();
    for (const word of ["tej samej sieci", "same network", "relay", "przekaźnik"])
      expect(text).not.toContain(word);
  } finally {
    await demo.close();
  }
});
