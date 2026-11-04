import { existsSync } from "node:fs";
import { join } from "node:path";
import { dashboardWindow, expect, test } from "../electron-test.ts";
import { nativeCreationHarness } from "../native-creation-support.ts";

test("quitting the native shell leaves no API token file", async () => {
  const harness = nativeCreationHarness();
  try {
    const host = await harness.startHost();
    const app = await harness.launchDesktop();
    const child = app.process();
    const { page } = await dashboardWindow(app);
    await expect(page.getByTestId("native-creation")).toBeVisible();
    await app.evaluate(({ app: electronApp }) => electronApp.quit());
    await expect.poll(() => child.exitCode, { timeout: 30_000 }).not.toBeNull();
    expect(existsSync(join(harness.dataDir, "api-token"))).toBe(false);
    expect(host.child.exitCode).toBeNull();
    await host.stop();
  } finally {
    await harness.cleanup();
  }
});
