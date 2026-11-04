/// <reference types="node" />
// The renderer's store port, relayed by Electron main to an explicit synthetic local host: the
// sandboxed window reads a query and runs commands through it with the real
// port client (bundled from e2e/store-harness). Own shell and isolated data dir are removed
// afterwards together with the host.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  alive,
  expect,
  hostPid,
  launchDesktop,
  stopHost,
  storeHarnessWindow,
  test,
} from "../electron-test.ts";
import { startSyntheticHost } from "../synthetic-host.ts";

function isolatedRoot(): string {
  const root = process.env.E2E_ROOT;
  if (!root) throw new Error("isolated E2E root is absent");
  return join(root, "native-host");
}

test("the window reads a query and runs commands through the store port, served by the host", async () => {
  const root = isolatedRoot();
  mkdirSync(root, { recursive: true });
  const dataDir = mkdtempSync(join(root, "s56b-store-port-"));
  const syntheticHost = await test.step("start synthetic host", () => startSyntheticHost(dataDir), {
    timeout: 20_000,
  });
  try {
    const app = await test.step(
      "launch native Electron",
      () => launchDesktop({ dataDir, env: { CASHU_DESKTOP_ALLOWED_DATA_ROOT: root } }),
      { timeout: 20_000 },
    );
    try {
      const page = await test.step(
        "open isolated native store page",
        () => storeHarnessWindow(app),
        {
          timeout: 20_000,
        },
      );
      expect(hostPid(dataDir)).toBe(syntheticHost.child.pid);
      expect(
        await page.evaluate(() => ({
          ownOrigin: location.origin === "app://cashu",
          bridge: "cashuCreation" in window,
          admission: new URL(location.href).searchParams.has("admission"),
        })),
      ).toEqual({ ownOrigin: true, bridge: true, admission: false });
      const result = await test.step(
        "query and command through host",
        () =>
          page.evaluate(() => {
            const harness = window as unknown as {
              cashuStoreHarness(): Promise<{
                vaults: number;
                before: string | null;
                renamed: unknown;
                after: string | null;
                refused: unknown;
              }>;
              cashuStoreStage(): string;
            };
            return Promise.race([
              harness.cashuStoreHarness(),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`store harness stalled at ${harness.cashuStoreStage()}`)),
                  10_000,
                ),
              ),
            ]);
          }),
        { timeout: 20_000 },
      );
      expect(result).toEqual({
        vaults: 1,
        before: "Demo",
        renamed: { kind: "completed", value: null },
        after: "Demo E2E",
        refused: { kind: "refused", reason: "exists" },
      });
      // The host owns the stores in this isolated data dir.
      const pid = hostPid(dataDir);
      expect(pid !== null && alive(pid)).toBe(true);
      expect(existsSync(join(dataDir, "stores", "device.db"))).toBe(true);
    } finally {
      await app.close().catch(() => {});
    }
    // Closing the window leaves the explicitly started host running until its idle exit.
    const pid = hostPid(dataDir);
    expect(pid !== null && alive(pid)).toBe(true);
  } finally {
    await stopHost(dataDir);
    await syntheticHost.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
});
