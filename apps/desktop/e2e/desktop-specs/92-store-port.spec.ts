/// <reference types="node" />
// The renderer's store port, relayed by Electron main to an explicit synthetic local host: the
// sandboxed window reads a query and runs commands through it with the real
// port client (bundled from e2e/store-harness). Own shell, own data dir under ~/cashu-lab (never a real
// one), removed afterwards together with the host.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import {
  alive,
  dashboardWindow,
  expect,
  hostPid,
  launchDesktop,
  stopHost,
  storeHarnessScript,
  test,
} from "../electron-test.ts";
import { startSyntheticHost } from "../synthetic-host.ts";

// The account's real home: the e2e global setup points HOME at a temp folder for the Python side.
const LAB_TMP = join(userInfo().homedir, "cashu-lab", "tmp");

test("the window reads a query and runs commands through the store port, served by the host", async () => {
  mkdirSync(LAB_TMP, { recursive: true });
  const dataDir = mkdtempSync(join(LAB_TMP, "s56b-store-port-"));
  const syntheticHost = await startSyntheticHost(dataDir);
  try {
    const app = await launchDesktop({
      dataDir,
      env: { CASHU_DESKTOP_ALLOWED_DATA_ROOT: LAB_TMP },
    });
    try {
      const { page } = await dashboardWindow(app);
      expect(hostPid(dataDir)).toBe(syntheticHost.child.pid);
      await page.evaluate(await storeHarnessScript());
      const result = await page.evaluate(() =>
        (
          window as unknown as {
            cashuStoreHarness(): Promise<{
              vaults: number;
              before: string | null;
              renamed: unknown;
              after: string | null;
              refused: unknown;
            }>;
          }
        ).cashuStoreHarness(),
      );
      expect(result).toEqual({
        vaults: 1,
        before: "Demo",
        renamed: { kind: "completed", value: null },
        after: "Demo E2E",
        refused: { kind: "refused", reason: "exists" },
      });
      // The host owns the stores in the data dir, beside (not inside) the Python sidecar's files.
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

test("the shared shell does not start a host while no page asked for a store port", async ({
  desktop,
}) => {
  expect(hostPid(desktop.dataDir)).toBeNull();
});
