/// <reference types="node" />
// The store process (Electron utility process) beside the Python sidecar, behind the dev flag: it
// opens a synthetic demo vault, and the sandboxed window reads a query and runs commands through its
// MessagePort with the real port client (bundled from e2e/store-harness). Own shell, own data dir
// under ~/cashu-lab (never a real one), removed afterwards.
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { build } from "rolldown";
import { dashboardWindow, expect, launchDesktop, test } from "../electron-test.ts";

// The account's real home: the e2e global setup points HOME at a temp folder for the Python side.
const LAB_TMP = join(userInfo().homedir, "cashu-lab", "tmp");

async function harnessScript(): Promise<string> {
  const appDir = process.env.E2E_APP_DIR as string;
  const out = await build({
    input: join(appDir, "e2e", "store-harness", "renderer.ts"),
    platform: "browser",
    write: false,
    resolve: { extensionAlias: { ".js": [".ts", ".tsx", ".js"] } },
    output: { format: "iife" },
    logLevel: "warn",
  });
  const chunk = out.output[0];
  if (chunk.type !== "chunk") throw new Error("the harness bundle has no code");
  return chunk.code;
}

test("the window reads a query and runs commands through the store port", async () => {
  mkdirSync(LAB_TMP, { recursive: true });
  const dataDir = mkdtempSync(join(LAB_TMP, "s53-store-port-"));
  try {
    const app = await launchDesktop({
      dataDir,
      env: { CASHU_DESKTOP_STORE: "1", CASHU_DESKTOP_ALLOWED_DATA_ROOT: LAB_TMP },
    });
    try {
      const { page } = await dashboardWindow(app);
      await page.evaluate(await harnessScript());
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
        renamed: { ok: true, value: null },
        after: "Demo E2E",
        refused: { ok: false, reason: "exists" },
      });
      // The store lives in the data dir, beside (not inside) the Python sidecar's files.
      expect(existsSync(join(dataDir, "store", "device.db"))).toBe(true);
    } finally {
      await app.close().catch(() => {});
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test("without the flag no store port is handed out", async ({ page }) => {
  const answered = await page.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        const onMessage = (event: MessageEvent) => {
          if ((event.data as { cashu?: unknown } | null)?.cashu === "store-port") resolve(true);
        };
        window.addEventListener("message", onMessage);
        window.postMessage({ cashu: "store-port-request" }, window.location.origin);
        setTimeout(() => resolve(false), 1_000);
      }),
  );
  expect(answered).toBe(false);
});
